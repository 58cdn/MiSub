let generation = 0;

export const currentSessionGeneration = () => generation;

// Requests retain their originating session even after authentication changes.
export function advanceSessionGeneration() {
    return ++generation;
}
