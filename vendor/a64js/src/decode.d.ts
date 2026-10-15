// a64js public API declaration; types preserved from the pinned upstream snapshot.
import type { DecodeOptions, DecodedInstruction } from './types.js';
export declare function decode(word: number, options?: DecodeOptions): DecodedInstruction;
export declare function createDecoder(options?: DecodeOptions): (word: number) => DecodedInstruction;
