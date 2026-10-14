export function backupSelectSql(name) {
  return 'SELECT * FROM "' + name.replaceAll('"', '""') + '"' +
    (name === 'pos_settings' ? " WHERE key NOT LIKE 'internal:img:%' AND key NOT LIKE 'internal:imgrate:%'" : '');
}
