/**
 * @file PromiseOperations.ts
 * @description Static analysis for JavaScript Promise usage patterns
 * 
 * This module analyzes JavaScript code to track Promise objects, their creation,
 * flow through the codebase, and relationships between different Promises.
 */

import { FragmentState } from "../analysis/fragmentstate";
import { ConstraintVar, FunctionReturnVar, Node, NodeVar } from "../analysis/constraintvars";
import { AllocationSiteToken } from "../analysis/tokens";
import Solver from "../analysis/solver";
import { locationToStringWithFileAndEnd } from "../misc/util";

/**
 * Types of Promise creation/usage that can be tracked in the analysis
 * - 'all': Track all Promise types (async functions, new Promise, Promise methods, built-in APIs)
 * - 'noasync': Only track explicit Promise creation (not async functions)
 * - 'newpromise': Only track direct Promise constructor usage
 */
export type PromiseFlag = 'all' | 'noasync' | 'newpromise';

/**
 * Type of chain method used on a Promise (.then/.catch/.finally)
 */
export type ChainMethodType = 'then' | 'catch' | 'finally';

/**
 * Describes a relationship between a Promise and its chained Promise
 */
export interface PromiseChainRelationship {
    /** The type of chaining method used */
    chainType: ChainMethodType;
    /** Hash identifier of the resulting Promise from the chain */
    chainPromiseId: string;
    /** Code location of the handler function */
    handlerLocation: string;
}

/**
 * Map from source Promise hash to all of its chained Promise relationships
 */
export const promiseChainMap = new Map<string, PromiseChainRelationship[]>();

/**
 * Records a Promise chaining relationship
 * 
 * @param sourcePromiseHash - Hash identifier for the source Promise
 * @param chainPromiseHash - Hash identifier for the resulting chained Promise
 * @param chainType - Type of chain method used (then/catch/finally)
 * @param handlerLocation - Code location of the handler function
 */
export function recordPromiseChain(
    sourcePromiseHash: string,
    chainPromiseHash: string,
    chainType: ChainMethodType,
    handlerLocation: string
): void {
    if (!sourcePromiseHash || !chainPromiseHash) {
        console.warn("Invalid Promise hash provided to recordPromiseChain");
        return;
    }

    if (!promiseChainMap.has(sourcePromiseHash)) {
        promiseChainMap.set(sourcePromiseHash, []);
    }

    promiseChainMap.get(sourcePromiseHash)!.push({
        chainType,
        chainPromiseId: chainPromiseHash,
        handlerLocation
    });
}

/**
 * Retrieves all chain relationships for a Promise
 * 
 * @param promiseHash - Hash identifier for the Promise
 * @returns Array of chain relationships
 */
export function getPromiseChains(promiseHash: string): PromiseChainRelationship[] {
    if (!promiseHash) {
        return [];
    }
    return promiseChainMap.get(promiseHash) || [];
}

/**
 * Type of Promise.* static method that combines multiple Promises
 */
export type AggregateMethodType = 'all' | 'race' | 'allSettled' | 'any';

/**
 * Describes a relationship between a Promise.all/race/etc result and its input Promises
 */
export interface PromiseInputRelationship {
    /** The aggregate method type used */
    methodType: AggregateMethodType;
    /** Hash identifier of an input Promise */
    inputPromise: string;
    /** Code location of the input in the aggregate method call */
    inputLocation: string;
}

/**
 * Map from result Promise hash to its input Promises for aggregate methods
 */
export const promiseInputMap = new Map<string, PromiseInputRelationship[]>();

/**
 * Records a relationship between an aggregate Promise and one of its inputs
 * 
 * @param resultPromiseHash - Hash identifier for the aggregate Promise result
 * @param inputPromiseHash - Hash identifier for one input Promise
 * @param methodType - Aggregate method type used (all/race/etc)
 * @param inputLocation - Code location of the input
 */
export function recordPromiseInput(
    resultPromiseHash: string,
    inputPromiseHash: string,
    methodType: AggregateMethodType,
    inputLocation: string
): void {
    if (!resultPromiseHash || !inputPromiseHash) {
        console.warn("Invalid Promise hash provided to recordPromiseInput");
        return;
    }

    if (!promiseInputMap.has(resultPromiseHash)) {
        promiseInputMap.set(resultPromiseHash, []);
    }

    promiseInputMap.get(resultPromiseHash)!.push({
        methodType,
        inputPromise: inputPromiseHash,
        inputLocation
    });
}

/**
 * Set of built-in APIs that return Promises
 */
const PROMISE_RETURNING_APIS = new Set([
    'fetch',
    'navigator.storage.persist',
    'indexedDB.open',
    'window.caches.open',
    'window.caches.match',
    'crypto.subtle.digest',
    'crypto.subtle.encrypt',
    'crypto.subtle.decrypt',
    'navigator.clipboard.readText',
    'navigator.clipboard.writeText',
    'navigator.getBattery',
    'navigator.geolocation.getCurrentPosition',
    'navigator.mediaDevices.getUserMedia',
    'WebSocket.close',
    // Add more Promise-returning APIs as needed
]);

/**
 * Checks if a node represents a call to a built-in Promise-returning API
 * 
 * @param node - The AST node to check
 * @returns True if the node is a built-in Promise API call
 */
function isBuiltInPromiseAPI(node: Node): boolean {
    if (!node || typeof node !== 'object') {
        return false;
    }

    try {
        if (node.type === "CallExpression") {
            // Check for direct API calls like fetch()
            if (node.callee && node.callee.type === "Identifier") {
                return PROMISE_RETURNING_APIS.has(node.callee.name);
            }

            // Check for member expressions like navigator.storage.persist()
            if (node.callee && node.callee.type === "MemberExpression") {
                const fullPath = getFullMemberExpressionPath(node.callee);
                return PROMISE_RETURNING_APIS.has(fullPath);
            }
        }
    } catch (err) {
        console.warn("Error in isBuiltInPromiseAPI:", err);
    }

    return false;
}

/**
 * Gets the full path of a member expression (e.g., "navigator.storage.persist")
 * 
 * @param node - The member expression node
 * @returns The full dot-notation path as a string
 */
function getFullMemberExpressionPath(node: any): string {
    if (!node) return "";

    try {
        if (node.type === "Identifier") {
            return node.name;
        }

        if (node.type === "MemberExpression") {
            const objectPath = getFullMemberExpressionPath(node.object);
            const propertyName = node.property.type === "Identifier" ? node.property.name : "";
            return objectPath ? `${objectPath}.${propertyName}` : propertyName;
        }
    } catch (err) {
        console.warn("Error in getFullMemberExpressionPath:", err);
        return "";
    }

    return "";
}

/**
 * Interface for Promise analysis results
 */
export interface PromiseAnalysisResult {
    /** Location where the Promise is defined */
    promiseDefinitionLocation: string;
    /** All functions that touch this Promise */
    functionsContainingAliases: string[];
    /** Count of functions that touch this Promise */
    functionTouchCount: number;
    /** Objects or arrays that contain this Promise */
    objectsContainingAliases: string[];
    /** Count of objects/arrays that contain this Promise */
    storedInObjectOrArrayCount: number;
    /** Locations where this Promise is awaited */
    awaitLocations: string[];
    /** Whether this Promise comes from an async function */
    isAsyncPromise: boolean;
    /** Chain relationships for this Promise */
    chainLocations: PromiseChainRelationship[];
    /** Whether this Promise results from an aggregate method */
    isAggregateMethodPromise: boolean;
    /** Input Promises to this aggregate Promise */
    inputPromises: PromiseInputRelationship[];
    /** Information about the Promise's usage across code boundaries */
    usage: {
        /** Whether the Promise is defined in application code */
        definedInApp: boolean;
        /** Whether an app-defined Promise is used in external code */
        usedExternally: boolean;
        /** Whether an external Promise is used in application code */
        externalDefinitionUsedInApp: boolean;
    };
}

/**
 * Temporary storage type for Promise analysis during construction
 */
interface PromiseEntryConstruction {
    promiseDefinitionLocation: string;
    functionsContainingAliases: Set<string>;
    functionTouchCount: number;
    objectsContainingAliases: Set<string>;
    storedInObjectOrArrayCount: number;
    awaitLocations: Set<string>;
    isAsyncPromise: boolean;
    chainLocations: PromiseChainRelationship[];
    isAggregateMethodPromise: boolean;
    inputPromises: PromiseInputRelationship[];
}

/**
 * Creates a new empty Promise analysis entry
 * 
 * @param location - The code location of the Promise
 * @returns A new Promise analysis object
 */
function createNewPromiseEntry(location: string): PromiseEntryConstruction {
    return {
        promiseDefinitionLocation: location,
        functionsContainingAliases: new Set<string>(),
        functionTouchCount: 0,
        objectsContainingAliases: new Set<string>(),
        storedInObjectOrArrayCount: 0,
        awaitLocations: new Set<string>(),
        isAsyncPromise: false,
        chainLocations: [],
        isAggregateMethodPromise: false,
        inputPromises: []
    };
}

/**
 * Checks if a node is a Promise creation site
 * 
 * @param node - The AST node to check
 * @param flag - The Promise flag indicating which types to include
 * @returns True if the node creates a Promise
 */
function isPromiseCreation(node: any, flag: PromiseFlag): boolean {
    if (!node || typeof node !== 'object') {
        return false;
    }

    try {
        // Helper function to check async functions
        const isAsyncFunction = () =>
        ((node.type === "FunctionDeclaration" ||
            node.type === "FunctionExpression" ||
            node.type === "ArrowFunctionExpression" ||
            node.type === "ClassMethod" ||
            node.type === "ObjectMethod" ||
            (node.type === "Property" && node.method === true)) &&
            node.async === true);

        // Helper function to check direct Promise creation
        const isNewPromise = () =>
            node.type === "NewExpression" &&
            node.callee &&
            node.callee.type === "Identifier" &&
            node.callee.name === "Promise";

        // Helper function to check Promise static methods and chains
        const isPromiseMethod = () => {
            if (node.type === "CallExpression" &&
                node.callee &&
                node.callee.type === "MemberExpression" &&
                node.callee.object &&
                node.callee.property) {

                // Static methods
                if (node.callee.object.type === "Identifier" &&
                    node.callee.object.name === "Promise" &&
                    node.callee.property.type === "Identifier") {

                    const methodName = node.callee.property.name;

                    if (["all", "race", "allSettled", "any"].includes(methodName)) {
                        (node as any).isPromiseStaticCall = true;
                        return true;
                    }

                    if (["resolve", "reject"].includes(methodName)) {
                        return true;
                    }
                }

                // Chain methods
                if (node.callee.property.type === "Identifier" &&
                    ["then", "catch", "finally"].includes(node.callee.property.name)) {
                    return true;
                }
            }
            return false;
        };

        switch (flag) {
            case 'all':
                return isAsyncFunction() ||
                    isNewPromise() ||
                    isPromiseMethod() ||
                    isBuiltInPromiseAPI(node);

            case 'noasync':
                return isNewPromise() ||
                    isPromiseMethod() ||
                    isBuiltInPromiseAPI(node);

            case 'newpromise':
                return isNewPromise();

            default:
                return false;
        }
    } catch (err) {
        console.warn("Error in isPromiseCreation:", err);
        return false;
    }
}

/**
 * Gets a unique identifier for a node
 * 
 * @param node - The constraint variable to get a hash for
 * @returns The node hash as a string or undefined if not available
 */
function getNodeIdentifier(node: ConstraintVar): string | undefined {
    if (!node) {
        return undefined;
    }

    try {
        if (node instanceof NodeVar && node.node) {
            return Solver.prototype.getNodeHash(node.node).toString();
        } else if (node instanceof FunctionReturnVar && node.fun) {
            return Solver.prototype.getNodeHash(node.fun).toString();
        }
    } catch (err) {
        console.warn("Error in getNodeIdentifier:", err);
    }

    return undefined;
}

/**
 * Gets the file path from a location string
 * 
 * @param location - Location string
 * @returns The file path
 */
function getFileFromLocation(location: string): string {
    try {
        const match = location.match(/^([^:]+):/);
        return match ? match[1] : "";
    } catch (err) {
        console.warn("Error extracting file from location:", err);
        return "";
    }
}

/**
 * Determines if a file is part of the application code based on package metadata
 * 
 * @param location - Code location string
 * @param solver - The analysis solver with global state
 * @returns True if the location is in application code, false if it's external
 */
function isApplicationCode(location: string, solver: Solver): boolean {
    try {
        const normalizedFilePath = location.split(':')[0];
        const moduleInfo = solver.globalState.moduleInfosByPath.get(normalizedFilePath);

        // Application code is marked with isEntry true and isIncluded true
        return Boolean(moduleInfo?.packageInfo?.isEntry && moduleInfo?.isIncluded);
    } catch (err) {
        console.warn("Error in isApplicationCode:", err);
        return false;
    }
}

/**
 * Analyzes if a Promise crosses between application and external code
 * 
 * @param defLocation - Promise definition location
 * @param touchLocations - Locations where the Promise is used
 * @param solver - The solver instance containing module metadata
 * @returns Object describing if and how the Promise crosses boundaries
 */
function analyzeCodeUsage(
    defLocation: string,
    touchLocations: string[],
    solver: Solver
): {
    definedInApp: boolean,
    usedExternally: boolean,
    externalDefinitionUsedInApp: boolean
} {
    let definedInApp = false;
    let usedExternally = false;
    let externalDefinitionUsedInApp = false;

    try {
        // Check if Promise is defined in application code
        definedInApp = isApplicationCode(defLocation, solver);

        // Check usage locations
        for (const location of touchLocations) {
            const isAppCode = isApplicationCode(location, solver);

            // If defined in app but used in external library code
            if (definedInApp && !isAppCode) {
                usedExternally = true;
            }

            // If defined in external library code but used in app
            if (!definedInApp && isAppCode) {
                externalDefinitionUsedInApp = true;
            }
        }
    } catch (err) {
        console.warn("Error in analyzeCodeUsage:", err);
    }

    return {
        definedInApp,
        usedExternally,
        externalDefinitionUsedInApp
    };
}

/**
 * Analyzes Promise usage in a code fragment
 * 
 * @param f - The fragment state to analyze
 * @param flag - The Promise flag indicating which types to track
 * @param solver - The solver instance containing module metadata
 * @returns Map of Promise identifiers to their analysis results
 */
export function getPromiseAliases(
    f: FragmentState,
    flag: PromiseFlag,
    solver: Solver
): Map<string, PromiseAnalysisResult> {
    if (!f || !solver) {
        console.error("Invalid fragment state or solver provided to getPromiseAliases");
        return new Map();
    }

    const promiseAliases = new Map<string, PromiseEntryConstruction>();

    try {
        // First pass: identify Promises and create basic entries
        for (const [var_, tokensObj] of f.getAllVarsAndTokens()) {
            try {
                // Skip if not a Promise creation site
                let isPromise = false;

                if (var_ instanceof NodeVar && var_.node) {
                    isPromise = isPromiseCreation(var_.node, flag);
                } else if (var_ instanceof FunctionReturnVar && var_.fun) {
                    isPromise = isPromiseCreation(var_.fun, flag);
                }

                if (!isPromise) {
                    continue;
                }

                // Get Promise identifier
                const promiseId = getNodeIdentifier(var_);
                if (!promiseId) {
                    continue;
                }

                // Skip if already processed
                if (promiseAliases.has(promiseId)) {
                    continue;
                }

                // Create new Promise entry
                promiseAliases.set(promiseId, createNewPromiseEntry(""));

                // Process tokens
                const tokens = Array.isArray(tokensObj) ? tokensObj : [...tokensObj];
                if (tokens.length === 0) {
                    continue;
                }

                for (const token of tokens) {
                    if (token instanceof AllocationSiteToken) {
                        if (token.kind === "Promise" && token.allocSite?.loc) {
                            const defAddress = locationToStringWithFileAndEnd(token.allocSite.loc);
                            const promiseInfo = promiseAliases.get(promiseId);
                            if (promiseInfo) {
                                promiseInfo.promiseDefinitionLocation = defAddress;

                                // Check for aggregate methods (Promise.all etc)
                                if (var_ instanceof NodeVar && var_.node.type === "CallExpression" &&
                                    var_.node.callee.type === "MemberExpression") {

                                    if (var_.node.callee.object.type === "Identifier" &&
                                        var_.node.callee.object.name === "Promise" &&
                                        var_.node.callee.property.type === "Identifier") {

                                        const methodName = var_.node.callee.property.name;
                                        if (["all", "race", "allSettled", "any"].includes(methodName)) {
                                            promiseInfo.isAggregateMethodPromise = true;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                // Delete entries without location
                if (promiseAliases.get(promiseId)?.promiseDefinitionLocation === "") {
                    promiseAliases.delete(promiseId);
                }
            } catch (err) {
                console.warn("Error processing variable:", err);
            }
        }

        // Second pass: track aliases and gather additional information
        for (const [promiseId, promiseInfo] of promiseAliases.entries()) {
            try {
                // Find the variable for this Promise
                let promiseVar: ConstraintVar | undefined;

                for (const [var_, _] of f.getAllVarsAndTokens()) {
                    if (getNodeIdentifier(var_) === promiseId) {
                        promiseVar = var_;
                        break;
                    }
                }

                if (!promiseVar) {
                    continue;
                }

                // Track all aliases of this Promise using constraint variable propagation
                const aliases = new Set<ConstraintVar>();
                const queue: ConstraintVar[] = [promiseVar];

                while (queue.length > 0) {
                    const v = queue.pop();
                    if (!v) continue;

                    if (v instanceof ConstraintVar) {
                        aliases.add(v);

                        // Add variables that this constraint variable flows to
                        const rep = f.getRepresentative(v);
                        if (rep) {
                            const subsetVars = f.subsetEdges.get(rep);
                            if (subsetVars) {
                                for (const sub of subsetVars) {
                                    if (!aliases.has(sub)) {
                                        queue.push(sub);
                                    }
                                }
                            }
                        }
                    }
                }

                // Process all aliases to gather information
                for (const alias of aliases) {
                    try {
                        // Properly handle different types of constraint variables
                        if (alias instanceof NodeVar && alias.node) {
                            const node = alias.node;

                            // Track await expressions
                            if (node.type === "AwaitExpression") {
                                if (node.loc) {
                                    const awaitLocation = locationToStringWithFileAndEnd(node.loc);
                                    promiseInfo.awaitLocations.add(awaitLocation);
                                }

                                // Find enclosing function for await expression
                                if (node.loc) {
                                    // Use the static analysis framework's built-in function to find the enclosing function
                                    const enclosingFunction = findEnclosingFunction(node, solver.fragmentState);
                                    if (enclosingFunction) {
                                        const funcLocation = enclosingFunction;
                                        promiseInfo.functionsContainingAliases.add(funcLocation);
                                    }
                                }
                            }

                            // For any node with a Promise alias, find its enclosing function
                            if (node.loc) {
                                const enclosingFunction = findEnclosingFunction(node, solver.fragmentState);
                                if (enclosingFunction) {
                                    const funcLocation = enclosingFunction;
                                    promiseInfo.functionsContainingAliases.add(funcLocation);
                                }
                            }

                            // Track object property assignments
                            if (node.type === "AssignmentExpression" && node.loc) {
                                if (node.left.type === "MemberExpression") {
                                    // This is an object property assignment (obj.prop = promise)
                                    const objLocation = locationToStringWithFileAndEnd(node.loc);
                                    promiseInfo.objectsContainingAliases.add(objLocation);
                                }
                            }

                            // Track array element assignments via member expression with computed property
                            if (node.type === "MemberExpression" && node.computed && node.loc) {
                                // This is likely an array element assignment (arr[i] = promise)
                                const arrLocation = locationToStringWithFileAndEnd(node.loc);
                                promiseInfo.objectsContainingAliases.add(arrLocation);
                            }

                            // Track object literals with Promise properties
                            if (node.type === "ObjectExpression" && node.properties && node.loc) {
                                // If this is an object literal that contains our Promise
                                const objLocation = locationToStringWithFileAndEnd(node.loc);
                                promiseInfo.objectsContainingAliases.add(objLocation);
                            }

                            // Track array literals with Promise elements
                            if (node.type === "ArrayExpression" && node.elements && node.loc) {
                                // If this is an array literal that contains our Promise
                                const arrLocation = locationToStringWithFileAndEnd(node.loc);
                                promiseInfo.objectsContainingAliases.add(arrLocation);
                            }
                        } else if (alias instanceof FunctionReturnVar && alias.fun) {
                            // Track async function returns
                            if (alias.fun.async) {
                                promiseInfo.isAsyncPromise = true;
                            }

                            // The function itself contains an alias
                            if (alias.fun.loc) {
                                const funLocation = locationToStringWithFileAndEnd(alias.fun.loc);
                                promiseInfo.functionsContainingAliases.add(funLocation);
                            }
                        }
                    } catch (err) {
                        console.warn("Error processing alias:", err);
                    }
                }

                // Track Promise parameters passed to functions
                for (const [func, params] of f.functionParameters) {
                    for (const param of params) {
                        if (aliases.has(param) && func?.loc) {
                            const functionLocation = locationToStringWithFileAndEnd(func.loc);
                            promiseInfo.functionsContainingAliases.add(functionLocation);
                        }
                    }
                }

                // Process chain relationships
                promiseInfo.chainLocations = getPromiseChains(promiseId);

                // Process input relationships for aggregate methods
                const inputRelationships = promiseInputMap.get(promiseId) || [];
                if (promiseInfo.isAggregateMethodPromise) {
                    promiseInfo.inputPromises = inputRelationships;
                }

                // Update counts for better access
                promiseInfo.functionTouchCount = promiseInfo.functionsContainingAliases.size;
                promiseInfo.storedInObjectOrArrayCount = promiseInfo.objectsContainingAliases.size;
            } catch (err) {
                console.warn(`Error processing Promise ${promiseId}:`, err);
            }
        }

        // Final pass: Analyze code usage patterns and create final results
        const finalResults = new Map<string, PromiseAnalysisResult>();

        for (const [promiseId, promiseInfo] of promiseAliases.entries()) {
            try {
                // Collect all locations where this Promise is touched
                const allTouchLocations: string[] = [
                    ...Array.from(promiseInfo.functionsContainingAliases),
                    ...Array.from(promiseInfo.objectsContainingAliases),
                    ...Array.from(promiseInfo.awaitLocations)
                ];

                // Add chain handler locations
                for (const chain of promiseInfo.chainLocations) {
                    allTouchLocations.push(chain.handlerLocation);
                }

                // Analyze code usage patterns using solver metadata
                const usageInfo = analyzeCodeUsage(
                    promiseInfo.promiseDefinitionLocation,
                    allTouchLocations,
                    solver
                );

                // Create the final result object
                finalResults.set(promiseId, {
                    promiseDefinitionLocation: promiseInfo.promiseDefinitionLocation,
                    functionsContainingAliases: Array.from(promiseInfo.functionsContainingAliases),
                    functionTouchCount: promiseInfo.functionTouchCount,
                    objectsContainingAliases: Array.from(promiseInfo.objectsContainingAliases),
                    storedInObjectOrArrayCount: promiseInfo.storedInObjectOrArrayCount,
                    awaitLocations: Array.from(promiseInfo.awaitLocations),
                    isAsyncPromise: promiseInfo.isAsyncPromise,
                    chainLocations: promiseInfo.chainLocations,
                    isAggregateMethodPromise: promiseInfo.isAggregateMethodPromise,
                    inputPromises: promiseInfo.inputPromises,
                    usage: usageInfo
                });
            } catch (err) {
                console.warn(`Error in final processing for Promise ${promiseId}:`, err);
            }
        }

        return finalResults;
    } catch (err) {
        console.error("Error in getPromiseAliases:", err);
        return new Map();
    }
}

/**
 * Checks if a node is storing a Promise in an object or array
 * 
 * @param node - The AST node to check
 * @param promiseInfo - The Promise info to update
 * @param solver - Solver instance for AST traversal
 */
/**
 * Finds the enclosing function for a node
 * 
 * @param node - The AST node to find the enclosing function for
 * @param f - The fragment state
 * @returns The location string of the enclosing function or undefined
 */
function findEnclosingFunction(node: any, f: FragmentState): string | undefined {
    if (!node || !node.loc) {
        return undefined;
    }

    try {
        // Use callToContainingFunction to find the enclosing function
        const containingFunc = f.callToContainingFunction.get(node);
        if (containingFunc && containingFunc.loc) {
            return locationToStringWithFileAndEnd(containingFunc.loc);
        }

        // For function nodes, return their own location
        if (node.type && (
            node.type === "FunctionDeclaration" ||
            node.type === "FunctionExpression" ||
            node.type === "ArrowFunctionExpression" ||
            node.type === "ClassMethod" ||
            node.type === "ClassPrivateMethod" ||
            node.type === "ObjectMethod"
        )) {
            return locationToStringWithFileAndEnd(node.loc);
        }

        // Check functional parameters
        for (const [func, params] of f.functionParameters) {
            for (const param of params) {
                if (param instanceof NodeVar && param.node === node && func && func.loc) {
                    return locationToStringWithFileAndEnd(func.loc);
                }
            }
        }
    } catch (err) {
        console.warn("Error in findEnclosingFunction:", err);
    }

    return undefined;
}

/**
 * Formats a Promise analysis result as a JSON-compatible object
 * 
 * @param promiseId - The Promise identifier
 * @param analysis - The analysis result
 * @returns Plain object representation 
 */
export function formatPromiseAnalysis(promiseId: string, analysis: PromiseAnalysisResult): Record<string, any> {
    return {
        [promiseId]: {
            promiseDefinitionLocation: analysis.promiseDefinitionLocation,
            functionsContainingAliases: analysis.functionsContainingAliases,
            functionTouchCount: analysis.functionTouchCount,
            objectsContainingAliases: analysis.objectsContainingAliases,
            storedInObjectOrArrayCount: analysis.storedInObjectOrArrayCount,
            awaitLocations: analysis.awaitLocations,
            isAsyncPromise: analysis.isAsyncPromise,
            chainLocations: analysis.chainLocations,
            isAggregateMethodPromise: analysis.isAggregateMethodPromise,
            inputPromises: analysis.inputPromises,
            usage: analysis.usage
        }
    };
}

/**
 * Creates a graph representation of Promise chains
 * 
 * @param promiseAnalysis - Map of Promise analysis results
 * @returns Graph representation with nodes and edges
 */
export function createPromiseGraph(promiseAnalysis: Map<string, PromiseAnalysisResult>): {
    nodes: Array<{ id: string; type: string; location: string }>;
    edges: Array<{ source: string; target: string; type: string }>;
} {
    const nodes: Array<{ id: string; type: string; location: string }> = [];
    const edges: Array<{ source: string; target: string; type: string }> = [];
    const nodeIds = new Set<string>();

    // Add nodes
    for (const [promiseId, analysis] of promiseAnalysis.entries()) {
        try {
            let type = "promise";
            if (analysis.isAsyncPromise) {
                type = "asyncPromise";
            } else if (analysis.isAggregateMethodPromise) {
                type = "aggregatePromise";
            }

            nodes.push({
                id: promiseId,
                type,
                location: analysis.promiseDefinitionLocation
            });

            nodeIds.add(promiseId);
        } catch (err) {
            console.warn(`Error creating node for Promise ${promiseId}:`, err);
        }
    }

    // Add chain edges
    for (const [promiseId, analysis] of promiseAnalysis.entries()) {
        try {
            // Add chain relationships
            for (const chain of analysis.chainLocations) {
                if (nodeIds.has(chain.chainPromiseId)) {
                    edges.push({
                        source: promiseId,
                        target: chain.chainPromiseId,
                        type: chain.chainType
                    });
                }
            }

            // Add input relationships for aggregate Promises
            if (analysis.isAggregateMethodPromise) {
                for (const input of analysis.inputPromises) {
                    if (nodeIds.has(input.inputPromise)) {
                        edges.push({
                            source: input.inputPromise,
                            target: promiseId,
                            type: `input_${input.methodType}`
                        });
                    }
                }
            }
        } catch (err) {
            console.warn(`Error creating edges for Promise ${promiseId}:`, err);
        }
    }

    return { nodes, edges };
}

/**
 * Analyzes Promise usage patterns in a module
 * 
 * @param promiseAnalysis - Map of Promise analysis results
 * @param modulePath - Path to the module
 * @returns Analysis of Promise patterns in that module
 */
export function analyzeModulePromisePatterns(
    promiseAnalysis: Map<string, PromiseAnalysisResult>,
    modulePath: string
): {
    promiseCount: number;
    asyncRatio: number;
    chainedRatio: number;
    aggregationRatio: number;
    crossModuleBoundary: number;
    mostCommonPatterns: Array<{ pattern: string; count: number }>;
} {
    const modulePromises = [...promiseAnalysis.values()].filter(
        analysis => analysis.promiseDefinitionLocation.startsWith(modulePath)
    );

    const totalPromises = modulePromises.length;
    if (totalPromises === 0) {
        return {
            promiseCount: 0,
            asyncRatio: 0,
            chainedRatio: 0,
            aggregationRatio: 0,
            crossModuleBoundary: 0,
            mostCommonPatterns: []
        };
    }

    // Calculate ratios
    const asyncCount = modulePromises.filter(p => p.isAsyncPromise).length;
    const chainedCount = modulePromises.filter(p => p.chainLocations.length > 0).length;
    const aggregateCount = modulePromises.filter(p => p.isAggregateMethodPromise).length;
    const crossModuleCount = modulePromises.filter(p =>
        p.usage.usedExternally || p.usage.externalDefinitionUsedInApp
    ).length;

    // Identify patterns
    const patterns = new Map<string, number>();

    for (const promise of modulePromises) {
        let pattern = promise.isAsyncPromise ? "async" : "explicit";

        if (promise.chainLocations.length > 0) {
            const chainTypes = new Set(promise.chainLocations.map(c => c.chainType));
            if (chainTypes.has("then")) pattern += "_then";
            if (chainTypes.has("catch")) pattern += "_catch";
            if (chainTypes.has("finally")) pattern += "_finally";
        }

        if (promise.awaitLocations.length > 0) {
            pattern += "_await";
        }

        if (promise.isAggregateMethodPromise && promise.inputPromises.length > 0) {
            const methodType = promise.inputPromises[0]?.methodType || "unknown";
            pattern += `_${methodType}`;
        }

        patterns.set(pattern, (patterns.get(pattern) || 0) + 1);
    }

    // Sort patterns by frequency
    const mostCommonPatterns = [...patterns.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([pattern, count]) => ({ pattern, count }));

    return {
        promiseCount: totalPromises,
        asyncRatio: asyncCount / totalPromises,
        chainedRatio: chainedCount / totalPromises,
        aggregationRatio: aggregateCount / totalPromises,
        crossModuleBoundary: crossModuleCount / totalPromises,
        mostCommonPatterns
    };
}

/**
 * Main function to run Promise analysis on a codebase
 * 
 * @param fragmentState - Fragment state from the static analyzer
 * @param projectRoot - Root path of the project
 * @param options - Analysis options
 * @returns Complete Promise analysis results
 */
export function analyzePromises(
    fragmentState: FragmentState,
    solver: Solver,
    options: {
        includeAsync?: boolean;
        includeBuiltins?: boolean;
        outputFormat?: 'json' | 'summary' | 'graph';
    } = {}
): any {
    try {
        const {
            includeAsync = true,
            includeBuiltins = true,
            outputFormat = 'json'
        } = options;

        // Determine which Promise flag to use
        let flag: PromiseFlag = 'all';
        if (!includeAsync) {
            flag = includeBuiltins ? 'noasync' : 'newpromise';
        }

        // Run the analysis
        const promiseAnalysis = getPromiseAliases(fragmentState, flag, solver);

        // Generate appropriate output format
        switch (outputFormat) {
            case 'summary':
                return generatePromiseSummary(promiseAnalysis);

            case 'graph':
                return createPromiseGraph(promiseAnalysis);

            case 'json':
            default:
                // Format as a plain object
                const result: Record<string, any> = {};
                for (const [promiseId, analysis] of promiseAnalysis.entries()) {
                    result[promiseId] = {
                        promiseDefinitionLocation: analysis.promiseDefinitionLocation,
                        functionsContainingAliases: analysis.functionsContainingAliases,
                        functionTouchCount: analysis.functionTouchCount,
                        objectsContainingAliases: analysis.objectsContainingAliases,
                        storedInObjectOrArrayCount: analysis.storedInObjectOrArrayCount,
                        awaitLocations: analysis.awaitLocations,
                        isAsyncPromise: analysis.isAsyncPromise,
                        chainLocations: analysis.chainLocations,
                        isAggregateMethodPromise: analysis.isAggregateMethodPromise,
                        inputPromises: analysis.inputPromises,
                        usage: analysis.usage
                    };
                }
                return result;
        }
    } catch (err) {
        console.error("Error in analyzePromises:", err);
        return { error: "Analysis failed", message: err };
    }
}

/**
 * Analyzes and produces a summary report of Promise usage in a codebase
 * 
 * @param promiseAnalysis - Map of Promise analysis results
 * @returns Summary statistics about Promise usage
 */
export function generatePromiseSummary(promiseAnalysis: Map<string, PromiseAnalysisResult>) {
    const summary = {
        totalPromises: promiseAnalysis.size,
        asyncFunctionPromises: 0,
        explicitPromises: 0,
        awaitedPromises: 0,
        chainedPromises: 0,
        aggregatedPromises: 0,
        promisesDefinedInApp: 0,
        appPromisesUsedExternally: 0,
        externalPromisesUsedInApp: 0,
        promiseAllUsage: 0,
        promiseRaceUsage: 0,
        promiseAllSettledUsage: 0,
        promiseAnyUsage: 0,
        fileWithMostPromises: { file: "", count: 0 },
        filesMap: new Map<string, number>()
    };

    const filePromiseCounts = new Map<string, number>();

    for (const [, promise] of promiseAnalysis) {
        // Count by type
        if (promise.isAsyncPromise) {
            summary.asyncFunctionPromises++;
        } else {
            summary.explicitPromises++;
        }

        // Usage patterns
        if (promise.awaitLocations.length > 0) {
            summary.awaitedPromises++;
        }

        if (promise.chainLocations.length > 0) {
            summary.chainedPromises++;
        }

        if (promise.isAggregateMethodPromise) {
            summary.aggregatedPromises++;

            // Count by aggregate method type
            if (promise.inputPromises.length > 0) {
                const methodType = promise.inputPromises[0].methodType;
                switch (methodType) {
                    case 'all':
                        summary.promiseAllUsage++;
                        break;
                    case 'race':
                        summary.promiseRaceUsage++;
                        break;
                    case 'allSettled':
                        summary.promiseAllSettledUsage++;
                        break;
                    case 'any':
                        summary.promiseAnyUsage++;
                        break;
                }
            }
        }

        // Code boundary statistics
        if (promise.usage.definedInApp) {
            summary.promisesDefinedInApp++;

            if (promise.usage.usedExternally) {
                summary.appPromisesUsedExternally++;
            }
        } else if (promise.usage.externalDefinitionUsedInApp) {
            summary.externalPromisesUsedInApp++;
        }

        // Track files
        const file = getFileFromLocation(promise.promiseDefinitionLocation);
        if (file) {
            filePromiseCounts.set(
                file,
                (filePromiseCounts.get(file) || 0) + 1
            );
        }
    }

    // Find file with most promises
    for (const [file, count] of filePromiseCounts.entries()) {
        if (count > summary.fileWithMostPromises.count) {
            summary.fileWithMostPromises = { file, count };
        }
    }

    summary.filesMap = filePromiseCounts;

    return summary;
}

// Export additional utility functions
export {
    isPromiseCreation
};