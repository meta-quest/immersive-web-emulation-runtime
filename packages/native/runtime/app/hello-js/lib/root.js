// Imports math.js too: the diamond must evaluate math.js once (MOD-4).
import { add } from './math.js';
export const rootValue = add(1, 1) === 2 ? 'root' : 'bad';
