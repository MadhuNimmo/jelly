import { FragmentState } from "../analysis/fragmentstate";
import { ConstraintVar, FunctionReturnVar, NodeVar, ObjectPropertyVar } from "../analysis/constraintvars";
import { AllocationSiteToken } from "../analysis/tokens";
import Solver from "../analysis/solver";
import { locationToStringWithFileAndEnd } from "../misc/util";
import { Node } from "@babel/types";
import { parentMap } from "../analysis/astvisitor";

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

    // function findEnclosingFunction(node: Node | undefined, f: FragmentState): string | undefined {
    //     while (node) {
    //         // Function types
    //         if (node.type === "FunctionDeclaration" || 
    //             node.type === "FunctionExpression" || 
    //             node.type === "ArrowFunctionExpression") {
    //             return locationToStringWithFileAndEnd(node.loc);
    //         }
    
    //         // Method definitions in classes
    //         if (node.type === "ClassMethod" ||
    //             node.type === "ClassPrivateMethod" ||
    //             node.type === "ObjectMethod") {
    //             return locationToStringWithFileAndEnd(node.loc);
    //         }
    
    //         // Getter/Setter methods
    //         if (node.type === "ClassProperty" ||
    //             node.type === "ClassPrivateProperty" ||
    //             node.type === "ObjectProperty") {
    //             const value = (node as any).value;
    //             if (value && (
    //                 value.type === "FunctionExpression" ||
    //                 value.type === "ArrowFunctionExpression"
    //             )) {
    //                 return locationToStringWithFileAndEnd(value.loc);
    //             }
    //         }
    
    //         // Special case for identifiers in function declarations
    //         if (node.type === "Identifier" && (node as any).parent?.type === "FunctionDeclaration") {
    //             return locationToStringWithFileAndEnd((node as any).parent.loc);
    //         }

    //         if (node.type==="AwaitExpression"){
    //             console.log("Here", node.parent)
    //         }
            
    //         // Check call-to-containing function map
    //         const enclosingFunction = f.callToContainingFunction.get(node);
    //         if (enclosingFunction) {
    //             return locationToStringWithFileAndEnd(enclosingFunction.loc);
    //         }
    
    //         node = (node as any).parent || undefined;
    //     }
    //     return undefined;
    // }

    function findEnclosingFunction(node: Node, parentMap: Map<Node, Node>, f: FragmentState): string | undefined {
        while (node) {
            if (node.type === "FunctionDeclaration" || 
                node.type === "FunctionExpression" || 
                node.type === "ArrowFunctionExpression") {
                return locationToStringWithFileAndEnd(node.loc);
            }
    
            if (node.type === "ClassMethod" ||
                node.type === "ClassPrivateMethod" ||
                node.type === "ObjectMethod") {
                return locationToStringWithFileAndEnd(node.loc);
            }
    
            // Check call-to-containing function map
            const enclosingFunction = f.callToContainingFunction.get(node);
            if (enclosingFunction) {
                return locationToStringWithFileAndEnd(enclosingFunction.loc);
            }
    
            // ✅ Use parent map to traverse upwards
            const parent = parentMap.get(node);
            if (!parent) break; // Exit if no parent is found
            node = parent;

        }

        if (node.type === "File") {
            return locationToStringWithFileAndEnd(node.loc);
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
                //console.log(promiseId, var_.node)
                promiseAliases.set(promiseId, createNewPromiseEntry(""));
            }
            
            
            for (const token of tokens) {

                if (token instanceof AllocationSiteToken && token.kind === "Promise") {
                    // if (!promiseAliases.has(promiseId)) {
                    //     promiseAliases.set(promiseId, createNewPromiseEntry(locationToStringWithFileAndEnd(var_.node.loc)));
                    // }
                    promiseAliases.get(promiseId).promiseDefinitionLocation = 
                       locationToStringWithFileAndEnd(var_.node.loc);//token.allocSite.loc
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
                console.log(alias)
                if (alias instanceof NodeVar) {
                    node = alias.node;
                    // Track await expressions
                    if (node.type === "AwaitExpression") {
                        const awaitLocation = locationToStringWithFileAndEnd(node.loc);
                        if (promiseAliases.has(promiseId)){
                            promiseAliases.get(promiseId).awaitLocations.add(awaitLocation);
                        }
                    
                        // Get enclosing function of the AwaitExpression
                        const enclosingFunction = findEnclosingFunction(node, parentMap, f);
                        if (promiseAliases.has(promiseId) && enclosingFunction) {
                            promiseAliases.get(promiseId).functionsContainingAliases.add(enclosingFunction);
                        }
                    }
                } else if (alias instanceof FunctionReturnVar) {
                    node = alias.fun;
                } else if (alias instanceof ObjectPropertyVar && "allocSite" in alias.obj) {
                    // Only count as stored in object if it's actually assigned to a property
                    const parentNode = (alias.obj.allocSite as any).parent;
                    const isPropertyAssignment = 
                        parentNode && 
                        (parentNode.type === "AssignmentExpression" || 
                        parentNode.type === "PropertyDefinition" ||
                        (parentNode.type === "Property" && 
                        !parentNode.method && // Exclude method definitions
                        !parentNode.get && // Exclude getters
                        !parentNode.set)); // Exclude setters

                    if (isPropertyAssignment) {
                        node = alias.obj.allocSite;
                        if (promiseAliases.has(promiseId)){
                            promiseAliases.get(promiseId).objectsContainingAliases.add(
                                locationToStringWithFileAndEnd(alias.obj.allocSite.loc)
                            );
                        }
                    }
                }

                if (node) {
                    const enclosingFunction = findEnclosingFunction(node, parentMap, f);
                    if (promiseAliases.has(promiseId) && enclosingFunction) {
                        promiseAliases.get(promiseId).functionsContainingAliases.add(enclosingFunction);
                    }
                }
            }

            // Track promises passed as parameters
            for (const [func, params] of f.functionParameters) {
                for (const param of params) {
                    if (promiseAliases.has(promiseId) && aliases.has(param)) {
                        const functionLocation = locationToStringWithFileAndEnd(func.loc);
                        promiseAliases.get(promiseId).functionsContainingAliases.add(functionLocation);
                    }
                }
            }

            // Update counts
            const promiseInfo = promiseAliases.get(promiseId);
            if (promiseInfo){
                promiseInfo.functionTouchCount = promiseInfo.functionsContainingAliases.size;
                promiseInfo.storedInObjectOrArrayCount = promiseInfo.objectsContainingAliases.size;
            }
            
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
    // First check if it's a Promise.all or similar static method call
    if (node.type === "CallExpression" && 
        node.callee.type === "MemberExpression" &&
        node.callee.object.name === "Promise") {
        
        // Ensure we capture the location for static methods
        if (["all", "race", "allSettled", "any"].includes(node.callee.property.name)) {
            // The allocation site should be the entire Promise.all call
            (node as any).isPromiseStaticCall = true;
            return true;
        }
        
        // Handle Promise.resolve/reject
        if (["resolve", "reject"].includes(node.callee.property.name)) {
            return true;
        }
    }

    return (
        // Direct Promise creation
        (node.type === "NewExpression" && node.callee.name === "Promise") ||
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
         (node.callee as any).parent.async === true) ||
        isBuiltInPromiseAPI(node)
    );
}

function getNodeIdentifier(node: NodeVar): string {
    return Solver.prototype.getNodeHash(node.node).toString();
}