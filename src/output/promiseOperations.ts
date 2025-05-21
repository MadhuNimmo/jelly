/**
 * @file PromiseOperations.ts
 * @description Static analysis for JavaScript Promise usage patterns
 * 
 * This module analyzes JavaScript code to track Promise objects, their creation,
 * flow through the codebase, and relationships between different Promises.
 */

import { FragmentState } from "../analysis/fragmentstate";
import { ConstraintVar, FunctionReturnVar, NodeVar, ObjectPropertyVar } from "../analysis/constraintvars";
import { AllocationSiteToken } from "../analysis/tokens";
import Solver from "../analysis/solver";
import { locationToStringWithFileAndEnd } from "../misc/util";
import { AnalysisStateReporter } from "./analysisstatereporter";
import { FunctionInfo, ModuleInfo } from "../analysis/infos";

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
 * Interface for Promise analysis results
 */
export interface PromiseAnalysisResult {
    /** Location where the Promise is defined */
    promiseDefinitionLocation: string;
    /** All functions that touch this Promise */
    functionsContainingAliases: Set<String>;
    /** Count of functions that touch this Promise */
    functionTouchCount: number;
    /** Objects or arrays that contain this Promise */
    objectsContainingAliases: Set<String>;
    /** Count of objects/arrays that contain this Promise */
    storedInObjectOrArrayCount: number;
    /** Locations where this Promise is awaited */
    awaitLocations: Set<String>;
    /** Whether this Promise comes from an async function */
    isAsyncPromise: boolean;
    /** Chain relationships for this Promise */
    chainLocations: PromiseChainRelationship[];
    /** Whether this Promise results from an aggregate method */
    isAggregateMethodPromise: boolean;
    /** Input Promises to this aggregate Promise */
    inputPromises: PromiseInputRelationship[];
    /** If the Promise is in reachable code */
    isReachable: boolean;
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
 * Checks if a node is a Promise creation site
 * 
 * @param node - The AST node to check
 * @param flag - The Promise flag indicating which types to include
 * @returns True if the node creates a Promise
 */
function isPromiseCreation(node: any): boolean {
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

        return isAsyncFunction() ||
            isNewPromise() ||
            isPromiseMethod();
    } catch (err) {
        console.warn("Error in isPromiseCreation:", err);
        return false;
    }
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
function isApplicationCode(location: String, solver: Solver): boolean {
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
 * Finds an enclosing function for a node
 * 
 * @param node - The AST node
 * @param f - The fragment state
 * @returns Location string of the function or undefined
 */
/**
 * Finds the enclosing function for a given AST node
 * 
 * @param node - The AST node to find the enclosing function for
 * @param solver - The solver instance with global state
 * @returns Tuple of [FunctionInfo/ModuleInfo, locationString] or [undefined, undefined]
 */
function findEnclosingFunction(node: any, solver: Solver): [ModuleInfo | FunctionInfo | undefined, string | undefined] {
    if (!node || !node.loc) {
        return [undefined, undefined];
    }

    try {
        // Strategy 1: Use callToContainingFunction map (most direct approach)
        const containingFunc = solver.fragmentState.callToContainingFunction.get(node);
        if (containingFunc && containingFunc.loc) {
            return [containingFunc, locationToStringWithFileAndEnd(containingFunc.loc)];
        }

        // Strategy 2: Check if node itself is a function
        if (node.type && (
            node.type === "FunctionDeclaration" ||
            node.type === "FunctionExpression" ||
            node.type === "ArrowFunctionExpression" ||
            node.type === "ClassMethod" ||
            node.type === "ClassPrivateMethod" ||
            node.type === "ObjectMethod"
        )) {
            return [solver.globalState.functionInfos.get(node), locationToStringWithFileAndEnd(node.loc)];
        }

        // Strategy 4: Walk up the AST parent chain if available
        let currentNode = node;
        while (currentNode && currentNode.parent) {
            currentNode = currentNode.parent;

            if (currentNode.type && (
                currentNode.type === "FunctionDeclaration" ||
                currentNode.type === "FunctionExpression" ||
                currentNode.type === "ArrowFunctionExpression" ||
                currentNode.type === "ClassMethod" ||
                currentNode.type === "ClassPrivateMethod" ||
                currentNode.type === "ObjectMethod"
            )) {
                return [
                    solver.globalState.functionInfos.get(currentNode),
                    locationToStringWithFileAndEnd(currentNode.loc)
                ];
            }
        }

        // Strategy 5: Use the function parameters map as a fallback
        for (const [func, params] of solver.fragmentState.functionParameters) {
            for (const param of params) {
                if (param instanceof NodeVar && param.node === node && func && func.loc) {
                    return [
                        solver.globalState.functionInfos.get(func),
                        locationToStringWithFileAndEnd(func.loc)
                    ];
                }
            }
        }

        // Strategy 6: Look for the function containing this node's range
        // This is a more expensive operation, so only do it as a last resort
        if (node.loc) {
            const nodeLoc = node.loc;
            const nodeStart = nodeLoc.start ? (nodeLoc.start.line * 10000 + nodeLoc.start.column) : 0;
            const nodeEnd = nodeLoc.end ? (nodeLoc.end.line * 10000 + nodeLoc.end.column) : 0;

            for (const [funcNode, funcInfo] of solver.globalState.functionInfos) {
                if (funcNode.loc) {
                    const funcStart = funcNode.loc.start ? (funcNode.loc.start.line * 10000 + funcNode.loc.start.column) : 0;
                    const funcEnd = funcNode.loc.end ? (funcNode.loc.end.line * 10000 + funcNode.loc.end.column) : 0;

                    // Check if node is inside this function's range
                    if (nodeStart >= funcStart && nodeEnd <= funcEnd) {
                        return [funcInfo, locationToStringWithFileAndEnd(funcNode.loc)];
                    }
                }
            }

            // If all else fails, try to get the module info
            const filePath = node.loc.source || (typeof node.loc.start === 'object' && node.loc.start.source);
            if (filePath) {
                const moduleInfo = solver.globalState.moduleInfosByPath.get(filePath);
                if (moduleInfo) {
                    return [moduleInfo, filePath];
                }
            }
        }
    } catch (err) {
        console.warn("Error in findEnclosingFunction:", err);
    }

    // If all strategies fail, return undefined
    return [undefined, undefined];
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
    solver: Solver,
    reachableFunctions: Set<FunctionInfo | ModuleInfo>
): Map<string, PromiseAnalysisResult> {
    if (!f || !solver) {
        console.error("Invalid fragment state or solver provided to getPromiseAliases");
        return new Map();
    }

    // Storage for Promise analysis information
    const promiseEntries: Map<string, {
        promiseDefinitionLocation: string;
        functionsContainingAliases: Set<String>;
        objectsContainingAliases: Set<String>;
        awaitLocations: Set<String>;
        isAsyncPromise: boolean;
        chainLocations: PromiseChainRelationship[];
        isAggregateMethodPromise: boolean;
        inputPromises: PromiseInputRelationship[];
        isReachable: boolean;
    }> = new Map();

    try {
        // First pass: identify Promises and create basic entries
        for (const [var_, tokensObj] of f.getAllVarsAndTokens()) {
            try {
                // Skip if not a Promise creation site
                let isPromise = false;

                if (var_ instanceof NodeVar && var_.node) {
                    isPromise = isPromiseCreation(var_.node);
                } else if (var_ instanceof FunctionReturnVar && var_.fun) {
                    isPromise = isPromiseCreation(var_.fun);
                }

                if (!isPromise) {
                    continue;
                }

                // Get Promise identifier
                let promiseId: string | undefined;
                if (var_ instanceof NodeVar && var_.node) {
                    promiseId = Solver.prototype.getNodeHash(var_.node).toString();
                } else if (var_ instanceof FunctionReturnVar && var_.fun) {
                    promiseId = Solver.prototype.getNodeHash(var_.fun).toString();
                }

                if (!promiseId) {
                    continue;
                }

                // Skip if already processed
                if (promiseEntries.has(promiseId)) {
                    continue;
                }

                // Create new Promise entry
                promiseEntries.set(promiseId, {
                    promiseDefinitionLocation: "",
                    functionsContainingAliases: new Set<String>(),
                    objectsContainingAliases: new Set<String>(),
                    awaitLocations: new Set<String>(),
                    isAsyncPromise: false,
                    chainLocations: [],
                    isAggregateMethodPromise: false,
                    inputPromises: [],
                    isReachable: false
                });

                // Process tokens
                const tokens = Array.isArray(tokensObj) ? tokensObj : [...tokensObj];
                if (tokens.length === 0) {
                    continue;
                }

                for (const token of tokens) {
                    if (token instanceof AllocationSiteToken) {
                        if (token.kind === "Promise" && token.allocSite?.loc) {
                            const defAddress = locationToStringWithFileAndEnd(token.allocSite.loc);
                            const promiseInfo = promiseEntries.get(promiseId);
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

                                // Find enclosing function for allocation site
                                const [enclosingFunction, enclosingFunctionLoc] = findEnclosingFunction(token.allocSite, solver);

                                if (enclosingFunction && reachableFunctions.has(enclosingFunction)) {
                                    promiseInfo.isReachable = true;
                                    if (enclosingFunctionLoc) {
                                        promiseInfo.functionsContainingAliases.add(enclosingFunctionLoc);
                                    }
                                }
                            }
                        }
                    }
                }

                // Delete entries without location
                if (promiseEntries.get(promiseId)?.promiseDefinitionLocation === "") {
                    promiseEntries.delete(promiseId);
                }
            } catch (err) {
                console.warn("Error processing variable:", err);
            }
        }

        // Second pass: track aliases and gather additional information
        for (const [promiseId, promiseInfo] of promiseEntries.entries()) {
            try {
                // Find the variable for this Promise
                let promiseVar: ConstraintVar | undefined;

                for (const [var_, _] of f.getAllVarsAndTokens()) {
                    let currentId: string | undefined;
                    if (var_ instanceof NodeVar && var_.node) {
                        currentId = Solver.prototype.getNodeHash(var_.node).toString();
                    } else if (var_ instanceof FunctionReturnVar && var_.fun) {
                        currentId = Solver.prototype.getNodeHash(var_.fun).toString();
                    }

                    if (currentId === promiseId) {
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
                            }

                            // For any node with a Promise alias, find its enclosing function
                            const [enclosingFunction, enclosingFunctionLoc] = findEnclosingFunction(node, solver);
                            if (enclosingFunction && enclosingFunctionLoc && reachableFunctions.has(enclosingFunction)) {
                                promiseInfo.functionsContainingAliases.add(enclosingFunctionLoc);
                            }

                        } else if (alias instanceof FunctionReturnVar && alias.fun) {
                            // Track async function returns
                            if (alias.fun.async) {
                                promiseInfo.isAsyncPromise = true;
                            }
                        }
                        else if (alias instanceof ObjectPropertyVar) {
                            // Track object properties that store Promises directly
                            if ('allocSite' in alias.obj) {
                                const objLoc = locationToStringWithFileAndEnd(alias.obj.allocSite.loc);
                                promiseInfo.objectsContainingAliases.add(objLoc);
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
            } catch (err) {
                console.warn(`Error processing Promise ${promiseId}:`, err);
            }
        }

        // Final pass: create results with proper typing
        const finalResults = new Map<string, PromiseAnalysisResult>();

        for (const [promiseId, promiseInfo] of promiseEntries.entries()) {
            if (promiseInfo.isReachable) {
                try {
                    // Collect all locations where this Promise is touched
                    const allTouchLocations: Set<String> = new Set(promiseInfo.functionsContainingAliases);

                    // Add chain handler locations
                    for (const chain of promiseInfo.chainLocations) {
                        allTouchLocations.add(chain.handlerLocation);
                    }

                    // Analyze code usage patterns
                    const definedInApp = isApplicationCode(promiseInfo.promiseDefinitionLocation, solver);
                    let usedExternally = false;
                    let externalDefinitionUsedInApp = false;

                    for (const location of allTouchLocations) {
                        const isAppCode = isApplicationCode(location, solver);

                        if (definedInApp && !isAppCode) {
                            usedExternally = true;
                        }

                        if (!definedInApp && isAppCode) {
                            externalDefinitionUsedInApp = true;
                        }
                    }

                    // Create the final result object with arrays instead of Sets
                    finalResults.set(promiseId, {
                        promiseDefinitionLocation: promiseInfo.promiseDefinitionLocation,
                        functionsContainingAliases: promiseInfo.functionsContainingAliases,
                        functionTouchCount: promiseInfo.functionsContainingAliases.size,
                        objectsContainingAliases: promiseInfo.objectsContainingAliases,
                        storedInObjectOrArrayCount: promiseInfo.objectsContainingAliases.size,
                        awaitLocations: promiseInfo.awaitLocations,
                        isAsyncPromise: promiseInfo.isAsyncPromise,
                        chainLocations: promiseInfo.chainLocations,
                        isAggregateMethodPromise: promiseInfo.isAggregateMethodPromise,
                        inputPromises: promiseInfo.inputPromises,
                        isReachable: promiseInfo.isReachable,
                        usage: {
                            definedInApp,
                            usedExternally,
                            externalDefinitionUsedInApp
                        }
                    });
                } catch (err) {
                    console.warn(`Error in final processing for Promise ${promiseId}:`, err);
                }
            }
        }

        return finalResults;
    } catch (err) {
        console.error("Error in getPromiseAliases:", err);
        return new Map();
    }
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
            isReachable: analysis.isReachable,
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
    const nodeIds = new Set<String>();

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

        if (promise.awaitLocations.size > 0) {
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
 * @param solver - Solver instance containing module metadata
 * @param options - Analysis options
 * @returns Complete Promise analysis results
 */
export function analyzePromises(
    fragmentState: FragmentState,
    solver: Solver,
): any {
    try {

        const reporter = new AnalysisStateReporter(solver.fragmentState);
        const allReachable = reporter.getReachableModulesAndFunctions(reporter.getEntryModules());     // Get reachable functions     
        const reachableFunctions = new Set(Array.from(allReachable).filter(
            (r): r is FunctionInfo | ModuleInfo => r instanceof FunctionInfo || r instanceof ModuleInfo));

        // Run the analysis
        const promiseAnalysis = getPromiseAliases(fragmentState, solver, reachableFunctions);

        // Format as a plain object
        const result: Record<string, any> = {};
        for (const [promiseId, analysis] of promiseAnalysis.entries()) {
            result[promiseId] = {
                promiseDefinitionLocation: analysis.promiseDefinitionLocation,
                functionsContainingAliases: Array.from(analysis.functionsContainingAliases),
                functionTouchCount: analysis.functionTouchCount,
                objectsContainingAliases: Array.from(analysis.objectsContainingAliases),
                storedInObjectOrArrayCount: analysis.storedInObjectOrArrayCount,
                awaitLocations: analysis.awaitLocations,
                isAsyncPromise: analysis.isAsyncPromise,
                chainLocations: analysis.chainLocations,
                isAggregateMethodPromise: analysis.isAggregateMethodPromise,
                inputPromises: analysis.inputPromises,
                isReachable: analysis.isReachable,
                usage: analysis.usage
            };
        }
        return result;
    } catch (err) {
        console.error("Error in analyzePromises:", err);
        return { error: "Analysis failed", message: String(err) };
    }
}

// Export additional utility functions
export {
    isPromiseCreation,
    isApplicationCode,
    getFileFromLocation
};