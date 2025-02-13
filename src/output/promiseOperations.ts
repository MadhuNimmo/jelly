import { FragmentState } from "../analysis/fragmentstate";
import { ConstraintVar, FunctionReturnVar, NodeVar, ObjectPropertyVar } from "../analysis/constraintvars";
import { AllocationSiteToken } from "../analysis/tokens";
import Solver from "../analysis/solver";
import { locationToStringWithFileAndEnd } from "../misc/util";
import { Node } from "@babel/types";

const PROMISE_RETURNING_APIS = new Set([
    'fetch'
]);
function isBuiltInPromiseAPI(node: any): boolean {
    if (node.type === "CallExpression") {
        // Check for direct API calls like fetch()
        if (node.callee.type === "Identifier") {
            return PROMISE_RETURNING_APIS.has(node.callee.name);
        }
    }
        return false;
    }
    

export function getPromiseAliases(f: FragmentState) {
    const promiseAliases = new Map();

    function findEnclosingFunction(node: Node | undefined, f: FragmentState): string | undefined {
        while (node) {
            if (node.type === "FunctionDeclaration" || 
                node.type === "FunctionExpression" || 
                node.type === "ArrowFunctionExpression") {
                return locationToStringWithFileAndEnd(node.loc);
            }

            if (node.type === "Identifier" && (node as any).parent?.type === "FunctionDeclaration") {
                return locationToStringWithFileAndEnd((node as any).parent.loc);
            }
            
            const enclosingFunction = f.callToContainingFunction.get(node);
            if (enclosingFunction) {
                return locationToStringWithFileAndEnd(enclosingFunction.loc);
            }
    
            node = (node as any).parent || undefined;
        }
        return undefined;
    }

    function createNewPromiseEntry(location: string) {
        return {
            promiseDefinitionLocation: location,
            functionsContainingAliases: new Set(),
            functionTouchCount: 0,
            objectsContainingAliases: new Set(),
            storedInObjectOrArrayCount: 0,
            chainedFrom: null,
            awaitLocations: new Set(),
            isAsyncPromise: false
        };
    }

    // First pass: Find all async functions and register their implicit promises
    for (const [var_, _] of f.getAllVarsAndTokens()) {
        if (var_ instanceof NodeVar) {
            const node = var_.node;
            
            // Check for async functions
            if ((node.type === "FunctionDeclaration" || 
                 node.type === "FunctionExpression" || 
                 node.type === "ArrowFunctionExpression") && 
                (node as any).async === true) {
                
                const promiseId = Solver.prototype.getNodeHash(node).toString() + "_async";
                if (!promiseAliases.has(promiseId)) {
                    promiseAliases.set(promiseId, createNewPromiseEntry(locationToStringWithFileAndEnd(node.loc)));
                    promiseAliases.get(promiseId).isAsyncPromise = true;
                    
                    // Add the function itself to the containing functions
                    const functionLocation = locationToStringWithFileAndEnd(node.loc);
                    promiseAliases.get(promiseId).functionsContainingAliases.add(functionLocation);
                }
            }
        }
    }

    // Second pass: Handle explicit promises and await expressions
    for (const [var_, tokens] of f.getAllVarsAndTokens()) {
        if (var_ instanceof NodeVar && isPromiseCreation(var_.node)) {
            const promiseId = getNodeIdentifier(var_);
            
            if (!promiseAliases.has(promiseId)) {
                promiseAliases.set(promiseId, createNewPromiseEntry(""));
            }
            
            for (const token of tokens) {
                if (token instanceof AllocationSiteToken && token.kind === "Promise") {
                    promiseAliases.get(promiseId).promiseDefinitionLocation = 
                        locationToStringWithFileAndEnd(token.allocSite.loc);
                }
            }
            
            const aliases = new Set<ConstraintVar>();
            const queue: ConstraintVar[] = [var_];
            
            while (queue.length) {
                const v = queue.pop();
                if (v instanceof ConstraintVar) {
                    aliases.add(v);
                    const subsetVars = f.subsetEdges.get(f.getRepresentative(v));
                    if (subsetVars) {
                        for (const sub of subsetVars) {
                            queue.push(sub);
                        }
                    }
                }
            }

            for (const alias of aliases) {
                let node: Node | undefined;

                if (alias instanceof NodeVar) {
                    node = alias.node;
                    // Track await expressions
                    if (node.type === "AwaitExpression") {
                        const awaitLocation = locationToStringWithFileAndEnd(node.loc);
                        promiseAliases.get(promiseId).awaitLocations.add(awaitLocation);
                    
                        // Get enclosing function of the AwaitExpression
                        const enclosingFunction = findEnclosingFunction(node, f);
                        if (enclosingFunction) {
                            promiseAliases.get(promiseId).functionsContainingAliases.add(enclosingFunction);
                        }
                    }
                } else if (alias instanceof FunctionReturnVar) {
                    node = alias.fun;
                } else if (alias instanceof ObjectPropertyVar && "allocSite" in alias.obj) {
                    node = alias.obj.allocSite;
                    promiseAliases.get(promiseId).objectsContainingAliases.add(
                        locationToStringWithFileAndEnd(alias.obj.allocSite.loc)
                    );
                }

                if (node) {
                    const enclosingFunction = findEnclosingFunction(node, f);
                    if (enclosingFunction) {
                        promiseAliases.get(promiseId).functionsContainingAliases.add(enclosingFunction);
                    }
                }
            }

            // Track promises passed as parameters
            for (const [func, params] of f.functionParameters) {
                for (const param of params) {
                    if (aliases.has(param)) {
                        const functionLocation = locationToStringWithFileAndEnd(func.loc);
                        promiseAliases.get(promiseId).functionsContainingAliases.add(functionLocation);
                    }
                }
            }

            // Update counts
            const promiseInfo = promiseAliases.get(promiseId);
            promiseInfo.functionTouchCount = promiseInfo.functionsContainingAliases.size;
            promiseInfo.storedInObjectOrArrayCount = promiseInfo.objectsContainingAliases.size;
        }
    }

    // Convert sets to arrays before returning
    return new Map(
        [...promiseAliases.entries()].map(([key, value]) => [
            key,
            {
                promiseDefinitionLocation: value.promiseDefinitionLocation,
                functionsContainingAliases: [...value.functionsContainingAliases],
                functionTouchCount: value.functionTouchCount,
                objectsContainingAliases: [...value.objectsContainingAliases],
                storedInObjectOrArrayCount: value.storedInObjectOrArrayCount,
                chainedFrom: value.chainedFrom,
                awaitLocations: [...value.awaitLocations],
                isAsyncPromise: value.isAsyncPromise
            }
        ])
    );
}

function isPromiseCreation(node: any): boolean {
    return (
        // Direct Promise creation
        (node.type === "NewExpression" && node.callee.name === "Promise") ||
        // Promise.resolve/reject
        (node.type === "CallExpression" && 
         node.callee.type === "MemberExpression" &&
         node.callee.object.name === "Promise" &&
         ["resolve", "reject", "all", "race", "allSettled", "any"].includes(node.callee.property.name)) ||
        // Await expressions
        node.type === "AwaitExpression" ||
        // Promise chain methods
        (node.type === "CallExpression" &&
         node.callee.type === "MemberExpression" &&
         ["then", "catch", "finally"].includes(node.callee.property.name)) ||
        // Async function calls
        (node.type === "CallExpression" &&
         node.callee.type === "Identifier" &&
         (node.callee as any).parent?.type === "FunctionDeclaration" &&
         (node.callee as any).parent.async === true)
        ||
        isBuiltInPromiseAPI(node)
    );
}

function getNodeIdentifier(node: NodeVar): string {
    return Solver.prototype.getNodeHash(node.node).toString();
}