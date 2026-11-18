// Shared reaction bounds. Leaf module: the store and the engine both read it,
// and neither may import the other.
const candidateLimit = 100;
const MAX_IDENTITY_ALIASES = 4;

module.exports = { candidateLimit, MAX_IDENTITY_ALIASES };
