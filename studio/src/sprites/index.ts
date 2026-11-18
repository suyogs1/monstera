// Public surface of the sprite library (tasks 3.1 and 3.2). The preview player (task 3.3) imports from here.
export * from "./edit";
export { frameIndex, type Hold } from "./timeline";
export { frameInBounds, gridExtent, sliceGrid, MAX_FRAMES_PER_SHEET } from "./slice";
export { dropFromSequence, framesUsedBy } from "./frames";
