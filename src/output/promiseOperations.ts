import { FragmentState } from "../analysis/fragmentstate";
import { ConstraintVar, FunctionReturnVar, NodeVar, ObjectPropertyVar } from "../analysis/constraintvars";
import { AllocationSiteToken } from "../analysis/tokens";
import Solver from "../analysis/solver";
import { locationToStringWithFileAndEnd } from "../misc/util";
import { Node } from "@babel/types";
import { parentMap } from "../analysis/astvisitor";

type PromiseFlag = 'all' | 'noasync' | 'newpromise';

export type PromiseChainRelationship = {
    chainType: 'then' | 'catch' | 'finally',
    chainPromiseId: string,     // Hash of target promise's allocation site
    handlerLocation: string    // Location of the handler function
  };
  
  export const promiseChainMap = new Map<string, PromiseChainRelationship[]>();
  
  export function recordPromiseChain(
    sourcePromiseHash: string,
    chainPromiseHash: string,
    chainType: 'then' | 'catch' | 'finally',
    handlerLocation: string
  ): void {
    if (!promiseChainMap.has(sourcePromiseHash)) {
      promiseChainMap.set(sourcePromiseHash, []);
    }
    
    promiseChainMap.get(sourcePromiseHash)!.push({
      chainType,
      chainPromiseId: chainPromiseHash,
      handlerLocation
    });
  }

  export function getPromiseChains(promiseHash: string): PromiseChainRelationship[] {
    return promiseChainMap.get(promiseHash) || [];
  }


  // Add to PromiseOperations.ts

export type AggregateMethodType = 'all' | 'race' | 'allSettled' | 'any';

export type PromiseInputRelationship = {
  methodType: AggregateMethodType,
  inputPromise: string,     // Hash of input promise's allocation site
  inputLocation: string     // Location of the input in the code
};

    // Map from result promise hash to its input promises
    export const promiseInputMap = new Map<string, PromiseInputRelationship[]>();

    export function recordPromiseInput(
    resultPromiseHash: string,
    inputPromiseHash: string,
    methodType: AggregateMethodType,
    inputLocation: string
    ): void {
    if (!promiseInputMap.has(resultPromiseHash)) {
        promiseInputMap.set(resultPromiseHash, []);
    }
    
    promiseInputMap.get(resultPromiseHash)!.push({
        methodType,
        inputPromise: inputPromiseHash,
        inputLocation
    });
    }
  

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
  

export function getPromiseAliases(f: FragmentState, flag: PromiseFlag ) {
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
            awaitLocations: new Set(),
            isAsyncPromise: false,
            chainLocations: new Set(),
            isAggregateMethodPromise: false,
            inputPromises: new Set()
        };
    }

    for (const [var_, tokens] of f.getAllVarsAndTokens()) {

        if ((var_ instanceof NodeVar && isPromiseCreation(var_.node, flag)) || (var_ instanceof FunctionReturnVar && isPromiseCreation(var_.fun, flag))) {
            const promiseId = getNodeIdentifier(var_);
            if (promiseId==undefined){
                continue
            }
            if (!promiseAliases.has(promiseId)) {
                promiseAliases.set(promiseId, createNewPromiseEntry(""));
            }
            
            if (Array.isArray(tokens) ? tokens.length > 1 : tokens.size > 1){
                console.log(var_, tokens)
            }
            
            for (const token of tokens) {

                if (token instanceof AllocationSiteToken) {
                    if (token.kind === "Promise") {
                        const defAddress = "node" in var_ ? 
                            locationToStringWithFileAndEnd(var_.node.loc, true) : 
                            locationToStringWithFileAndEnd(var_.fun.loc, true);
                            
                        const promiseInfo = promiseAliases.get(promiseId);
                        promiseInfo.promiseDefinitionLocation = defAddress;

                        if (var_ instanceof NodeVar && var_.node.type === "CallExpression" &&
                            var_.node.callee.type === "MemberExpression") {
                            
                            // Static methods
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
                } else if ((alias instanceof ObjectPropertyVar)){

                        if (alias.obj instanceof AllocationSiteToken && (alias.obj.kind === "Object" || alias.obj.kind === "Array")) {
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

            if (promiseAliases.has(promiseId)){
                const promiseInfo =  promiseAliases.get(promiseId)
                const inputRelationships = promiseInputMap.get(promiseId) || [];
                if (promiseInfo.isAggregateMethodPromise) {
                    promiseInfo.inputPromises = inputRelationships;
                }
                promiseInfo.functionTouchCount = promiseInfo.functionsContainingAliases.size;
                promiseInfo.storedInObjectOrArrayCount = promiseInfo.objectsContainingAliases.size;
                promiseInfo.chainLocations = getPromiseChains(promiseId);
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
                awaitLocations: [...value.awaitLocations],
                isAsyncPromise: value.isAsyncPromise,
                chainLocations: [...value.chainLocations],
                isAggregateMethodPromise: value.isAggregateMethodPromise,
                inputPromises: [...value.inputPromises]

            }
        ])
    );
}

function isPromiseCreation(node: any, flag: PromiseFlag): boolean {

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
        node.callee.name === "Promise";

    // Helper function to check Promise static methods and chains
    const isPromiseMethod = () => {
        if (node.type === "CallExpression" &&
            node.callee.type === "MemberExpression") {
            
            // Static methods
            if (node.callee.object.name === "Promise") {
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
            if (["then", "catch", "finally"].includes(node.callee.property.name)) {
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
}

export function getNodeIdentifier(node: any): string | undefined {
    if (node instanceof NodeVar){
        return Solver.prototype.getNodeHash(node.node).toString();
    }else if(node instanceof FunctionReturnVar){
        return Solver.prototype.getNodeHash(node.fun).toString();
    }
    return undefined
}