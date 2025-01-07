import { FragmentState } from "../analysis/fragmentstate";
import { NodeVar } from "../analysis/constraintvars";
import { locationToString } from "../misc/util";
import Solver from "../analysis/solver";

// Type definitions
export type PromiseFlow = {
        nodeId: string;
        location: string;
        type: 'creation' | 'assignment' | 'operation' | 'other';
        operation?: string;
        variableName?: string;
}

export type PromiseDataFlow = {
        paths: Array<PromiseFlow[]>;
}

// Main function to get promise data flows
export function getPromiseDataFlows(f: FragmentState): Map<String, PromiseDataFlow> {
        const promiseFlows = new Map<String, PromiseDataFlow>();

        // Helper functions moved inside to maintain scope
        function trackPromiseFlow(node: NodeVar): void {
                const paths = findAllPaths(f, node);
                if (paths.length > 0) {
                        promiseFlows.set(getNodeIdentifier(node), { paths });
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
                // Look for operations where this identifier is used
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

// Export additional utilities if needed
export {
        getNodeIdentifier,
        isPromiseCreation,
        getNodeType,
        getOperationType,
        getVariableName
};