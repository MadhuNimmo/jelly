import { FragmentState } from "../analysis/fragmentstate";
import { NodeVar } from "../analysis/constraintvars";
import { locationToString } from "../misc/util";
import Solver from "../analysis/solver";


export type PromiseHandler = {
        type: 'resolve' | 'reject';
        exists: boolean;
        hasReturn?: boolean;
        location?: string;
        expectsParameter?: boolean;
}

export type PromiseOperation = {
        type: 'then' | 'catch' | 'finally';
        handlers: PromiseHandler[];
        location: string;
        hasReturn: boolean;
        expectsParameter: boolean;
}


export type PromiseIssueType = 'missing_resolve' | 'missing_reject' | 'missing_return' | 'unhandled_rejection' | 'missing_handlers' | 'missing_all_handlers';

export type PromiseIssue = {
        type: PromiseIssueType;
        location?: string;
        details?: string;
        variable?: string;
        expected_parameter?: string[];
        path?: PromiseFlow[];
}

// Extend PromiseDataFlow to include handler information
export type PromiseDataFlow = {
        paths: Array<PromiseFlow[]>;
        operations: PromiseOperation[];
        potentialIssues: PromiseIssue[];
}

// Type definitions
export type PromiseFlow = {
        nodeId: string;
        location: string;
        type: 'creation' | 'assignment' | 'operation' | 'other';
        operation?: string;
        variableName?: string;
        chainId?: string;
}



function analyzePromiseHandlers(node: NodeVar): PromiseOperation | undefined {
        if (node.node.type === "CallExpression" &&
                node.node.callee?.type === "MemberExpression") {

                const property = node.node.callee.property;
                const method = property.type === 'Identifier' ? property.name : undefined;

                if (method === 'then' || method === 'catch' || method === 'finally') {
                        const handlers: PromiseHandler[] = [];
                        let hasReturnInChain = false;
                        let expectsParamInChain = false;

                        if (method === 'then') {
                                // Check resolve handler
                                if (node.node.arguments.length > 0) {
                                        const handler = node.node.arguments[0];
                                        const handlerHasReturn = hasExplicitReturn(handler);
                                        const expectsParam = handlerExpectsParameter(handler);
                                        hasReturnInChain = handlerHasReturn;
                                        expectsParamInChain = expectsParam;

                                        handlers.push({
                                                type: 'resolve',
                                                exists: true,
                                                hasReturn: handlerHasReturn,
                                                expectsParameter: expectsParam,
                                                location: locationToString(handler.loc, true, true)
                                        });
                                }

                                // Check reject handler (second argument)
                                if (node.node.arguments.length > 1) {
                                        const handler = node.node.arguments[1];
                                        const handlerHasReturn = hasExplicitReturn(handler);
                                        const expectsParam = handlerExpectsParameter(handler);

                                        handlers.push({
                                                type: 'reject',
                                                exists: true,
                                                hasReturn: handlerHasReturn,
                                                expectsParameter: expectsParam,
                                                location: locationToString(handler.loc, true, true)
                                        });
                                }
                        } else if (method === 'catch') {
                                // Check catch handler
                                if (node.node.arguments.length > 0) {
                                        const handler = node.node.arguments[0];
                                        const handlerHasReturn = hasExplicitReturn(handler);
                                        const expectsParam = handlerExpectsParameter(handler);

                                        handlers.push({
                                                type: 'reject',
                                                exists: true,
                                                hasReturn: handlerHasReturn,
                                                expectsParameter: expectsParam,
                                                location: locationToString(handler.loc, true, true)
                                        });
                                }
                        }
                        // finally doesn't need special handling for our analysis

                        const operation: PromiseOperation = {
                                type: method,
                                handlers,
                                location: locationToString(node.node.loc, true, true),
                                hasReturn: hasReturnInChain,
                                expectsParameter: expectsParamInChain
                        };

                        return operation;
                }
        }
        return undefined;
}

//Helper functions needed by analyzePromiseHandlers
function hasExplicitReturn(handler: any): boolean {
        if (handler.type === "ArrowFunctionExpression" || handler.type === "FunctionExpression") {
                if (handler.body.type === "BlockStatement") {
                        // Check for return statements in block
                        return handler.body.body.some((stmt: any) => stmt.type === "ReturnStatement");
                } else {
                        // Implicit return for arrow functions with expression bodies
                        return true;
                }
        }
        return false;
}
function findNodeForFlow(flow: PromiseFlow, f: FragmentState): NodeVar | undefined {
        // Find the NodeVar that corresponds to this flow's nodeId
        for (const [var_, _] of f.getAllVarsAndTokens()) {
                if (var_ instanceof NodeVar) {
                        // Compare using getNodeIdentifier to match the flow's nodeId
                        if (getNodeIdentifier(var_) === flow.nodeId) {
                                return var_;
                        }
                }
        }
        return undefined;
}


function handlerExpectsParameter(handler: any): boolean {
        if (handler.type === "ArrowFunctionExpression" || handler.type === "FunctionExpression") {
                return handler.params.length > 0;
        }
        return false;
}


// Main function to get promise data flows

function trackChainOperations(path: PromiseFlow[], f: FragmentState){
        const operations: PromiseOperation[] = [];
        const issues: PromiseIssue[] = [];
    
        // Collect all operations first
        for (const flow of path) {
                if (flow.type === 'operation' && flow.operation) {
                const node = findNodeForFlow(flow, f);
                if (node) {
                        const operation = analyzePromiseHandlers(node);
                        if (operation) {
                        operations.push(operation);
                        }
                }
                }
        
        }
        
        // Check for missing resolve handler (then)
        const hasThen = operations.some(op => op.type === 'then');
        if (!hasThen) {
        issues.push({
                type: 'missing_resolve',
                path: path
        });
        }

         // Check for missing reject handler (catch)
        const hasCatch = operations.some(op => op.type === 'catch');
        if (!hasCatch) {
                issues.push({
                        type: 'missing_reject',
                        path: path
                });
        }
       
    
        // Analyze chain of then operations
        const thenOperations = operations.filter(op => op.type === 'then');
        for (let i = 0; i < thenOperations.length - 1; i++) {
            const currentThen = thenOperations[i];
            const currentHandler = currentThen.handlers[0]; // resolve handler
            
            if (currentHandler && !currentHandler.hasReturn) {
                // Check if any subsequent then expects parameters
                const subsequentThens = thenOperations.slice(i + 1);
                const expectingThens = subsequentThens.filter(op => 
                    op.handlers[0]?.expectsParameter
                );
    
                if (expectingThens.length > 0) {
                    issues.push({
                        type: 'missing_return',
                        location: currentHandler.location || currentThen.location,
                        expected_parameter: expectingThens.map(op => 
                            op.handlers[0]?.location || op.location
                        ),
                        details: 'Missing return in promise chain before then(s) that expect parameters'
                    });
                    break; // Only reports the first occurrence
                }
            }
        }
    
        return { operations, issues };
    }

export function getPromiseDataFlows(f: FragmentState): Map<String, PromiseDataFlow> {
        const promiseFlows = new Map<String, PromiseDataFlow>();

        function trackPromiseFlow(node: NodeVar): void {
                const paths = findAllPaths(f, node);
                if (paths.length > 0) {
                        const allOperations: PromiseOperation[][] = [];
                        let allIssues: PromiseIssue[] = [];

                        // Process each path as a separate chain
                        for (const path of paths) {
                                const { operations, issues } = trackChainOperations(path, f);
                                allOperations.push(operations);
                                allIssues = allIssues.concat(issues);  
                        }
                        console.log(allOperations,allIssues)
                        promiseFlows.set(getNodeIdentifier(node), {
                                paths,
                                operations: allOperations.flat(),
                                potentialIssues: allIssues
                        });
                }
        }

        // Process all nodes
        for (const [var_, _] of f.getAllVarsAndTokens()) {
                if (var_ instanceof NodeVar && isPromiseCreation(var_.node)) {
                        trackPromiseFlow(var_);
                }
        }

        return promiseFlows;
}

// Helper functions
function findAllPaths(f: FragmentState, startNode: NodeVar): Array<PromiseFlow[]> {
        const allPaths: Array<PromiseFlow[]> = [];
        const currentPath: PromiseFlow[] = [];

        function dfs(node: NodeVar, visitedInPath: Set<string>) {
                const nodeKey = `${node.node.start}-${node.node.end}`;
                if (visitedInPath.has(nodeKey)) return;

                const localVisited = new Set(visitedInPath);
                localVisited.add(nodeKey);

                const flow: PromiseFlow = {
                        nodeId: getNodeIdentifier(node),
                        location: locationToString(node.node.loc, true, true),
                        type: getNodeType(node.node),
                        operation: getOperationType(node.node),
                        variableName: getVariableName(node.node)
                };

                currentPath.push(flow);

                const edges = getNextNodes(node, f);
                if (edges.length === 0 && currentPath.length > 0) {
                        allPaths.push([...currentPath]);
                } else {
                        for (const next of edges) {
                                dfs(next, localVisited);
                        }
                }

                currentPath.pop();
        }

        dfs(startNode, new Set());
        return allPaths;
}

function getNodeIdentifier(node: NodeVar): string {
        return Solver.prototype.getNodeHash(node.node).toString();
}

function getNextNodes(node: NodeVar, f: FragmentState): NodeVar[] {
        const edges: NodeVar[] = [];
        const targets = f.subsetEdges.get(f.getRepresentative(node)) || new Set();

        // First add direct operations on this node if it's an identifier
        if (node.node.type === 'Identifier') {
                for (const [var_, _] of f.getAllVarsAndTokens()) {
                        if (var_ instanceof NodeVar) {
                                // Check if this is a call expression on our identifier
                                if (var_.node.type === 'CallExpression' &&
                                        var_.node.callee?.type === 'MemberExpression' &&
                                        var_.node.callee.object?.type === 'Identifier' &&
                                        var_.node.callee.object.name === node.node.name) {
                                        edges.push(var_);
                                }
                        }
                }
        }

        // Add chained operations
        if (node.node.type === 'CallExpression' &&
                node.node.callee?.type === 'MemberExpression') {
                for (const [var_, _] of f.getAllVarsAndTokens()) {
                        if (var_ instanceof NodeVar &&
                                var_.node.type === 'CallExpression' &&
                                var_.node.callee?.type === 'MemberExpression') {
                                // Check if this call's object is the result of our current call
                                const callee = var_.node.callee;
                                if (callee.object.type === 'CallExpression' &&
                                        areNodesEqual(callee.object, node.node)) {
                                        edges.push(var_);
                                }
                        }
                }
        }

        // Then add assignments/declarations
        for (const target of targets) {
                if (target instanceof NodeVar &&
                        (target.node.type === 'Identifier' ||
                                target.node.type === 'VariableDeclarator' ||
                                target.node.type === 'AssignmentExpression' ||
                                (target.node.type === 'CallExpression' &&
                                        target.node.callee?.type === 'MemberExpression'))) {
                        edges.push(target);
                }
        }

        return edges;
}

function isPromiseCreation(node: any): boolean {
        return (
                (node.type === "NewExpression" && node.callee.name === "Promise") ||
                (node.type === "CallExpression" &&
                        node.callee.object?.name === "Promise" &&
                        ["resolve", "reject"].includes(node.callee.property?.name))
        );
}

function getNodeType(node: any): 'creation' | 'assignment' | 'operation' {
        if (isPromiseCreation(node)) {
                return 'creation';
        } else if (node.type === "Identifier") {
                return 'assignment';
        } else {
                return 'operation';
        }
}

function getOperationType(node: any): string | undefined {
        if (node.type === "CallExpression" && node.callee?.property?.name) {
                return node.callee.property.name;
        }
        return undefined;
}

function getVariableName(node: any): string | undefined {
        if (node.type === "VariableDeclarator") {
                return node.id.name;
        } else if (node.type === "AssignmentExpression") {
                return node.left.name;
        } else if (node.type === "Identifier") {
                return node.name;
        }
        return undefined;
}

function areNodesEqual(node1: any, node2: any): boolean {
        return node1.start === node2.start &&
                node1.end === node2.end &&
                node1.loc.start.line === node2.loc.start.line &&
                node1.loc.start.column === node2.loc.start.column;
}

// Export additional utilities if needed
export {
        getNodeIdentifier,
        isPromiseCreation,
        getNodeType,
        getOperationType,
        getVariableName
};