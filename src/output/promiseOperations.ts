import { FragmentState } from "../analysis/fragmentstate";
import { NodeVar } from "../analysis/constraintvars";
import { locationToString } from "../misc/util";
import { writeFileSync } from "fs";
import traverse, { NodePath } from "@babel/traverse";
import { Function, Node, File } from "@babel/types";
import { GlobalState } from "../analysis/globalstate";
import { ModuleInfo, FunctionInfo } from "../analysis/infos";
const globalState = new GlobalState();

type PromiseFlow = {
    nodeId: string;
    location: string;
    type: "declaration" | "assignment" | "function" | "method" | "chain" | "reference" | "operation";
    operation?: string;
    variableName?: string;
};

type PromiseFragment = {
    id: string;
    type: PromiseFlow["type"];
    code: string;
    location: string;
    containingFunction?: string;
    contextualCode?: string;
};

type PromiseUsageGraph = {
    promiseId: string;
    creationLocation: string;
    fragments: PromiseFragment[];
};

export class PromiseAnalyzer {
    private fragmentState: FragmentState;
    private globalState: GlobalState;
    private promiseGraphs: Map<string, PromiseUsageGraph>;
    private ast: File;

    constructor(fragmentState: FragmentState, globalState: GlobalState, ast: File) {
        this.fragmentState = fragmentState;
        this.globalState = globalState;
        this.promiseGraphs = new Map();
        this.ast = ast;
    }

    /**
     * Finds the enclosing function or module for a given NodeVar.
     */
    private findEnclosingFunctionOrModule(node: NodeVar): Function | ModuleInfo | undefined {
        console.log(`🔍 Finding enclosing function/module for node at ${locationToString(node.node.loc)}`);

        const nodePath = this.findNodePath(node.node);
        if (!nodePath) {
            console.warn("⚠️ Could not find NodePath for node!");
            return undefined;
        }

        const moduleInfo = this.globalState.getModuleInfo(nodePath.node.loc?.filename ?? "unknown");
        const enclosing = this.globalState.getEnclosingFunctionOrModule(nodePath, moduleInfo);

        if (enclosing instanceof FunctionInfo) {
            return enclosing.fun; // ✅ Return actual function node from FunctionInfo
        }

        return enclosing;
    }

    /**
     * Searches the AST for the given node and returns its NodePath.
     */
    private findNodePath(targetNode: Node): NodePath<Node> | undefined {
        let foundPath: NodePath<Node> | undefined = undefined;

        traverse(this.ast, {
            enter(path) {
                if (path.node === targetNode) {
                    foundPath = path;
                    path.stop();
                }
            }
        });

        return foundPath;
    }

    /**
     * Creates a promise fragment from the node.
     */
    private createFragment(node: NodeVar, type: PromiseFlow["type"]): PromiseFragment {
        const id = `fragment_${node.node.start}_${node.node.end}`;
        const code = this.extractSourceFromNode(node.node);
        const context = this.extractFunctionContext(node);

        return {
            id,
            type,
            code,
            location: locationToString(node.node.loc, true, true),
            containingFunction: this.findEnclosingFunctionOrModule(node)?.toString(),
            contextualCode: context
        };
    }

    /**
     * Extracts source code from the node.
     */
    private extractSourceFromNode(node: Node): string {
        if (!node.loc) return "";
        try {
            const { start, end } = node.loc;
            return `[Code at ${start.line}:${start.column}-${end.line}:${end.column}]`;
        } catch (e) {
            console.warn("Could not extract source from node:", e);
            return "";
        }
    }

    /**
     * Extracts function context from the node.
     */
    private extractFunctionContext(node: NodeVar): string {
        try {
            const enclosing = this.findEnclosingFunctionOrModule(node);
            return enclosing ? `Function/Module: ${enclosing}` : "No context";
        } catch (e) {
            console.warn("Could not extract function context:", e);
            return "";
        }
    }

    /**
     * Retrieves the identifier for a node.
     */
    private getNodeIdentifier(node: NodeVar): string {
        return `node_${node.node.start}_${node.node.end}`;
    }

    private isPromiseCreation(node: Node): boolean {
        return node.type === "NewExpression" && node.callee?.type === "Identifier" && node.callee.name === "Promise";
    }
    

    /**
     * Determines the type of promise usage.
     */
    private getNodeType(node: NodeVar): PromiseFlow["type"] {
        if (this.isPromiseCreation(node.node)) return "declaration";
        if (node.node.type === "CallExpression") {
            const callee = node.node.callee;
            if (callee?.type === "Identifier") return "function";
            if (callee?.type === "MemberExpression" && callee.property?.type === "Identifier") {
                const methodName = callee.property.name;
                if (["then", "catch", "finally"].includes(methodName)) {
                    return "chain";
                }
            }
        }
        if (node.node.type === "AwaitExpression") return "operation";
        if (node.node.type === "VariableDeclarator") return "assignment";
        if (node.node.type === "Identifier") return "reference";
        return "method";
    }

    /**
     * Finds the next nodes connected to a given promise-related node.
     */
    private getNextNodes(node: NodeVar): NodeVar[] {
        const edges: NodeVar[] = [];
        return edges;
    }

    /**
     * Tracks promise flow from its creation and collects fragments.
     */
    private trackPromiseFlow(var_: NodeVar) {
        const promiseId = `promise_${var_.node.start}_${var_.node.end}`;
        console.log(`\n🚀 Starting to track promise: ${promiseId}`);

        if (!this.promiseGraphs.has(promiseId)) {
            this.promiseGraphs.set(promiseId, {
                promiseId,
                creationLocation: locationToString(var_.node.loc, true, true),
                fragments: []
            });
        }

        const promiseGraph = this.promiseGraphs.get(promiseId)!;
        const visited = new Set<string>();

        const trackNode = (currentNode: NodeVar) => {
            const nodeId = this.getNodeIdentifier(currentNode);
            if (visited.has(nodeId)) return;

            visited.add(nodeId);
            const fragment = this.createFragment(currentNode, this.getNodeType(currentNode));
            if (!promiseGraph.fragments.some(f => f.id === fragment.id)) {
                promiseGraph.fragments.push(fragment);
            }

            const nextNodes = this.getNextNodes(currentNode);
            for (const nextNode of nextNodes) {
                trackNode(nextNode);
            }
        };

        trackNode(var_);
    }

    /**
     * Collects all promise fragments.
     */
    public collectPromiseFragments(): Map<string, PromiseUsageGraph> {
        for (const [var_, _] of this.fragmentState.getAllVarsAndTokens()) {
            if (var_ instanceof NodeVar) {
                this.trackPromiseFlow(var_);
            }
        }
        return this.promiseGraphs;
    }
}

/**
 * Extracts and writes promise fragments.
 */
export function extractAndWritePromiseFragments(
    fragmentState: FragmentState,
    globalState: GlobalState,
    ast: File,
    outputFile: string
) {
    const analyzer = new PromiseAnalyzer(fragmentState, globalState, ast);
    const promiseGraphs = analyzer.collectPromiseFragments();

    writeFileSync(outputFile, JSON.stringify({ promises: Array.from(promiseGraphs.values()) }, null, 2));

    return { promiseCount: promiseGraphs.size, outputFile };
}
