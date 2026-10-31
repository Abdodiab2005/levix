const DATA_UNAVAILABLE = 78;
const DATA_ERRORS = new Set([
  "SCHEMA_NEWER", "BACKUP_FAILED", "MIGRATION_FAILED", "DATABASE_NOT_PREPARED",
  "ACTIVATION_RECOVERY_FAILED",
]);

function exitCodeFor(error) {
  return DATA_ERRORS.has(error?.code) ? DATA_UNAVAILABLE : null;
}

module.exports = { DATA_UNAVAILABLE, exitCodeFor };
