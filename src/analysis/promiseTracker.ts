// PromiseTracker.ts

export type PromiseId = string;
export type OperationType = string;


interface PromiseOperationData {
  location: string;
  relatedPromiseId?: PromiseId;
  flags?: { [key: string]: any };
  context?: string;
}

export class PromiseTracker {
  private operations: Map<PromiseId, Map<OperationType, Set<PromiseOperationData>>> = new Map();

  private promiseReturningFunctions: Set<string> = new Set();

  addOperation(
    promiseId: PromiseId, 
    operation: string, 
    locationStr: string, 
    relatedPromiseId?: string | null, 
    flags?: { [key: string]: any } | null, 
    context?: string | null
  ) {
    // Initialize maps if they don't exist
    if (!this.operations.has(promiseId)) {
      this.operations.set(promiseId, new Map());
    }
    const promiseOps = this.operations.get(promiseId)!;
    
    const opType = operation as OperationType;

    if (!promiseOps.has(opType)) {
      promiseOps.set(opType, new Set());
    }

    const opData: PromiseOperationData = {
        location: locationStr,
    };

    if (relatedPromiseId) opData.relatedPromiseId = relatedPromiseId;
    if (flags) opData.flags = flags;
    if (context) opData.context = context;

    promiseOps.get(opType)!.add(opData);
  }

  getOperations(promiseId: PromiseId): Array<[OperationType, PromiseOperationData]> {
    const result: Array<[OperationType, PromiseOperationData]> = [];
    const promiseOps = this.operations.get(promiseId);
    
    if (promiseOps) {
      for (const [opType, opSet] of promiseOps.entries()) {
        for (const opData of opSet) {
          result.push([opType, opData]);
        }
      }
    }
    
    return result;
  }

  getOperationsByType(promiseId: PromiseId, type: OperationType): PromiseOperationData[] {
    const promiseOps = this.operations.get(promiseId);
    if (!promiseOps) return [];
    
    const typeOps = promiseOps.get(type);
    if (!typeOps) return [];
    
    return Array.from(typeOps);
  }

  reportOperations(): Record<string, any> {
        return this.mapToObject(this.operations);

      }
    
  // Recursive mapToObject method to convert Maps and Sets
  private mapToObject(
  map: Map<string, any> | Set<any> | any
  ): Record<string, any> | any[] | any {
  if (map instanceof Map) {
          const obj: Record<string, any> = {};
          for (const [key, value] of map.entries()) {
          obj[key] = this.mapToObject(value); // Recursively convert nested Maps or Sets
          }
          return obj;
  } else if (map instanceof Set) {
          return Array.from(map); // Convert Set to Array
  }
  return map; // Return value if neither Map nor Set
  }

  // Add method to record a function that returns promises
  addPromiseReturningFunction(functionId: string) {
    this.promiseReturningFunctions.add(functionId);
  }

  // Check if a function returns promises
  hasPromiseReturningFunction(functionId: string): boolean {
      return this.promiseReturningFunctions.has(functionId);
  }

  // Get all functions that return promises
  getPromiseReturningFunctions(): string[] {
      return Array.from(this.promiseReturningFunctions);
  }

}