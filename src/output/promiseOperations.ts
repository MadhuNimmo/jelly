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
            //chainedFrom: null,
            awaitLocations: new Set(),
            isAsyncPromise: false
        };
    }

    for (const [var_, tokens] of f.getAllVarsAndTokens()) {
        if ((var_ instanceof NodeVar && isPromiseCreation(var_.node)) || (var_ instanceof FunctionReturnVar && isPromiseCreation(var_.fun))) {
            const promiseId = getNodeIdentifier(var_);
            if (promiseId==undefined){
                continue
            }
            if (!promiseAliases.has(promiseId)) {
                promiseAliases.set(promiseId, createNewPromiseEntry(""));
            }
            
            
            for (const token of tokens) {

                if (token instanceof AllocationSiteToken && token.kind === "Promise") {
                    const defAddress = "node" in var_ ? locationToStringWithFileAndEnd(var_.node.loc, true) : locationToStringWithFileAndEnd(var_.fun.loc, true); //token.allocSite.loc
                    promiseAliases.get(promiseId).promiseDefinitionLocation = defAddress;
                }
            }

            if (promiseAliases.get(promiseId).promiseDefinitionLocation==""){
                promiseAliases.delete(promiseId)
                continue
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
                //console.log(alias)
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
                    if (node.async){
                        promiseAliases.get(promiseId).isAsyncPromise= true;
                    }
                } else if (alias instanceof ObjectPropertyVar && alias.obj instanceof AllocationSiteToken 
                    && (alias.obj.kind === "Object" || alias.obj.kind === "Array")) {
                    if (promiseAliases.has(promiseId)){
                        promiseAliases.get(promiseId).objectsContainingAliases.add(
                            locationToStringWithFileAndEnd(alias.obj.allocSite.loc)
                        );
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

            if (promiseAliases.has(promiseId)){
                const promiseInfo =  promiseAliases.get(promiseId)
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
                //chainedFrom: value.chainedFrom,
                awaitLocations: [...value.awaitLocations],
                isAsyncPromise: value.isAsyncPromise
            }
        ])
    );
}

function isPromiseCreation(node: any): boolean {
    if ((node.type === "FunctionDeclaration" || 
        node.type === "FunctionExpression" || 
        node.type === "ArrowFunctionExpression") && 
       node.async === true) {
       return true;
   }
   
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
        // Promise chain methods
        (node.type === "CallExpression" &&
         node.callee.type === "MemberExpression" &&
         ["then", "catch", "finally"].includes(node.callee.property.name)) ||
        isBuiltInPromiseAPI(node)
    );
}

function getNodeIdentifier(node: any): string | undefined {
    if (node instanceof NodeVar){
        return Solver.prototype.getNodeHash(node.node).toString();
    }else if(node instanceof FunctionReturnVar){
        return Solver.prototype.getNodeHash(node.fun).toString();
    }
    return undefined
}