const crypto = require('crypto');
const fs = require('fs/promises');

function quoteIdentifier(identifier) {
    if (!/^[A-Za-z0-9_]+$/.test(identifier)) {
        throw new Error(`Unsupported SQL identifier: ${identifier}`);
    }
    return `\`${identifier}\``;
}

function splitSql(value, delimiter = ',') {
    const parts = [];
    let start = 0;
    let depth = 0;
    let quote = null;
    let escaped = false;

    for (let index = 0; index < value.length; index++) {
        const character = value[index];
        if (quote) {
            if (escaped) escaped = false;
            else if (character === '\\' && quote !== '`') escaped = true;
            else if (character === quote) {
                if (value[index + 1] === quote && quote !== '`') index++;
                else quote = null;
            }
            continue;
        }

        if (character === '`' || character === "'" || character === '"') {
            quote = character;
        } else if (character === '(') {
            depth++;
        } else if (character === ')') {
            depth--;
        } else if (character === delimiter && depth === 0) {
            parts.push(value.slice(start, index).trim());
            start = index + 1;
        }
    }

    const last = value.slice(start).trim();
    if (last) parts.push(last);
    return parts;
}

function splitStatements(sql) {
    return splitSql(sql, ';').filter(statement => statement.trim());
}

function findClosingParen(value, openIndex) {
    let depth = 0;
    let quote = null;
    let escaped = false;

    for (let index = openIndex; index < value.length; index++) {
        const character = value[index];
        if (quote) {
            if (escaped) escaped = false;
            else if (character === '\\' && quote !== '`') escaped = true;
            else if (character === quote) {
                if (value[index + 1] === quote && quote !== '`') index++;
                else quote = null;
            }
            continue;
        }

        if (character === '`' || character === "'" || character === '"') quote = character;
        else if (character === '(') depth++;
        else if (character === ')' && --depth === 0) return index;
    }
    return -1;
}

function normalizeType(type) {
    return type.toUpperCase()
        .replace(/\s*\(/g, '(')
        .replace(/\b(TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT)\(\d+\)/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeDefault(value, isSqlLiteral = false) {
    if (value === null || value === undefined) return 'NULL';
    let normalized = String(value).trim();
    if (isSqlLiteral && ((normalized.startsWith("'") && normalized.endsWith("'")) || (normalized.startsWith('"') && normalized.endsWith('"')))) {
        const quote = normalized[0];
        normalized = normalized.slice(1, -1).replace(new RegExp(`${quote}${quote}`, 'g'), quote).replace(/\\'/g, "'").replace(/\\\\/g, '\\');
        return `VALUE:${normalized}`;
    }
    if (/^CURRENT_TIMESTAMP(?:\(\d*\))?$/i.test(normalized)) {
        return normalized.toUpperCase().replace('()', '');
    }
    if (/^NULL$/i.test(normalized)) return 'NULL';
    if (/^[-+]?\d+(?:\.\d+)?$/.test(normalized)) return `NUMBER:${Number(normalized)}`;
    return `VALUE:${normalized}`;
}

function parseColumnDefinition(definition) {
    const match = definition.match(/^`?([A-Za-z0-9_]+)`?\s+(.+)$/s);
    if (!match) return null;

    const [, name, body] = match;
    const typeMatch = body.match(/^([A-Za-z]+(?:\s*\([^)]*\))?(?:\s+(?:UNSIGNED|ZEROFILL))?)/i);
    if (!typeMatch) throw new Error(`Could not read column type: ${definition}`);

    const defaultMatch = body.match(/\bDEFAULT\s+((?:'[^']*(?:''[^']*)*'|"[^"]*(?:""[^"]*)*")|CURRENT_TIMESTAMP(?:\(\d*\))?|NULL|[-+]?\d+(?:\.\d+)?)/i);
    const onUpdateMatch = body.match(/\bON\s+UPDATE\s+([A-Za-z]+(?:\(\d*\))?)/i);
    return {
        name,
        definition,
        type: normalizeType(typeMatch[1]),
        nullable: !/\bNOT\s+NULL\b/i.test(body),
        defaultValue: normalizeDefault(defaultMatch ? defaultMatch[1] : null, Boolean(defaultMatch && /^['"]/.test(defaultMatch[1]))),
        autoIncrement: /\bAUTO_INCREMENT\b/i.test(body),
        onUpdate: onUpdateMatch ? onUpdateMatch[1].toUpperCase().replace('()', '') : null
    };
}

function parseIndexDefinition(definition) {
    let match = definition.match(/^PRIMARY\s+KEY\s*\((.*)\)$/is);
    let name = 'PRIMARY';
    let unique = true;
    let columnsText;

    if (match) {
        columnsText = match[1];
    } else {
        match = definition.match(/^UNIQUE\s+(?:KEY|INDEX)\s+`?([A-Za-z0-9_]+)`?\s*\((.*)\)$/is);
        if (match) {
            name = match[1];
            columnsText = match[2];
        } else {
            match = definition.match(/^(?:KEY|INDEX)\s+`?([A-Za-z0-9_]+)`?\s*\((.*)\)$/is);
            if (!match) return null;
            name = match[1];
            unique = false;
            columnsText = match[2];
        }
    }

    const columns = splitSql(columnsText).map(column => {
        const columnMatch = column.match(/^`?([A-Za-z0-9_]+)`?(?:\s*\(\s*(\d+)\s*\))?/);
        if (!columnMatch) throw new Error(`Could not read index column: ${column}`);
        return { name: columnMatch[1].toLowerCase(), prefix: columnMatch[2] ? Number(columnMatch[2]) : null };
    });
    return { name, unique, columns, definition };
}

function parseCreateTables(sql) {
    const tables = [];
    for (const statement of splitStatements(sql)) {
        const match = statement.match(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([A-Za-z0-9_]+)`?\s*\(/i);
        if (!match) continue;

        const openIndex = statement.indexOf('(', match.index + match[0].length - 1);
        const closeIndex = findClosingParen(statement, openIndex);
        if (closeIndex < 0) throw new Error(`Could not parse CREATE TABLE for ${match[1]}`);

        const elements = splitSql(statement.slice(openIndex + 1, closeIndex));
        const columns = [];
        const indexes = [];
        for (const element of elements) {
            const index = parseIndexDefinition(element);
            if (index) {
                indexes.push(index);
                continue;
            }
            const column = parseColumnDefinition(element);
            if (column) columns.push(column);
            else if (/^(CONSTRAINT|FOREIGN\s+KEY|CHECK\s*\()/i.test(element)) {
                throw new Error(`Automatic migration does not support this table constraint: ${element}`);
            }
        }

        tables.push({
            name: match[1],
            createSql: statement,
            columns,
            indexes,
            engine: (statement.slice(closeIndex + 1).match(/\bENGINE\s*=\s*([A-Za-z0-9_]+)/i) || [])[1] || null,
            charset: (statement.slice(closeIndex + 1).match(/\b(?:DEFAULT\s+)?CHARSET\s*=\s*([A-Za-z0-9_]+)/i) || [])[1] || null
        });
    }
    if (tables.length === 0) throw new Error('No CREATE TABLE statements were found in database.sql.');
    return tables;
}

function compareColumn(expected, actual) {
    const actualDefault = normalizeDefault(actual.COLUMN_DEFAULT);
    const expectedAutoIncrement = expected.autoIncrement;
    const actualAutoIncrement = /\bauto_increment\b/i.test(actual.EXTRA || '');
    const expectedOnUpdate = expected.onUpdate;
    const actualOnUpdateMatch = String(actual.EXTRA || '').match(/\bon update\s+([a-z]+(?:\(\d*\))?)/i);
    const actualOnUpdate = actualOnUpdateMatch ? actualOnUpdateMatch[1].toUpperCase().replace('()', '') : null;

    return normalizeType(actual.COLUMN_TYPE) !== expected.type ||
        (actual.IS_NULLABLE === 'YES') !== expected.nullable ||
        actualDefault !== expected.defaultValue ||
        actualAutoIncrement !== expectedAutoIncrement ||
        actualOnUpdate !== expectedOnUpdate;
}

function indexSignature(index) {
    return `${index.unique ? 1 : 0}:${index.columns.map(column => `${column.name}${column.prefix ? `(${column.prefix})` : ''}`).join(',')}`;
}

async function getColumns(db, tableName) {
    const [rows] = await db.execute(`
        SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, ORDINAL_POSITION
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION
    `, [tableName]);
    return rows;
}

async function getIndexes(db, tableName) {
    const [rows] = await db.execute(`
        SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SUB_PART, SEQ_IN_INDEX
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
        ORDER BY INDEX_NAME, SEQ_IN_INDEX
    `, [tableName]);
    const grouped = new Map();
    for (const row of rows) {
        if (!grouped.has(row.INDEX_NAME)) {
            grouped.set(row.INDEX_NAME, { name: row.INDEX_NAME, unique: Number(row.NON_UNIQUE) === 0, columns: [] });
        }
        grouped.get(row.INDEX_NAME).columns.push({
            name: String(row.COLUMN_NAME).toLowerCase(),
            prefix: row.SUB_PART === null ? null : Number(row.SUB_PART)
        });
    }
    return [...grouped.values()];
}

async function getTableInfo(db, tableName) {
    const [rows] = await db.execute(`
        SELECT ENGINE, TABLE_COLLATION
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
    `, [tableName]);
    return rows[0] || null;
}

async function buildMigrationActions(db, table) {
    const actions = [];
    const warnings = [];
    const tableInfo = await getTableInfo(db, table.name);
    const quotedTable = quoteIdentifier(table.name);
    if (!tableInfo) {
        return { actions: [{ description: `Create table ${table.name}`, sql: table.createSql }], warnings };
    }

    const actualColumns = await getColumns(db, table.name);
    const actualColumnsByName = new Map(actualColumns.map(column => [column.COLUMN_NAME.toLowerCase(), column]));
    const desiredColumnNames = new Set(table.columns.map(column => column.name.toLowerCase()));

    for (const column of table.columns) {
        const actual = actualColumnsByName.get(column.name.toLowerCase());
        if (!actual) {
            actions.push({
                description: `Add column ${table.name}.${column.name}`,
                sql: `ALTER TABLE ${quotedTable} ADD COLUMN ${column.definition}`
            });
        } else if (compareColumn(column, actual)) {
            actions.push({
                description: `Modify column ${table.name}.${column.name}`,
                sql: `ALTER TABLE ${quotedTable} MODIFY COLUMN ${column.definition}`
            });
        }
    }
    for (const actual of actualColumns) {
        if (!desiredColumnNames.has(actual.COLUMN_NAME.toLowerCase())) {
            warnings.push(`Column ${table.name}.${actual.COLUMN_NAME} is absent from database.sql and was preserved.`);
        }
    }

    const actualIndexes = await getIndexes(db, table.name);
    const desiredIndexesByName = new Map(table.indexes.map(index => [index.name.toLowerCase(), index]));
    const actualIndexesByName = new Map(actualIndexes.map(index => [index.name.toLowerCase(), index]));
    const indexesToDrop = new Set();
    for (const actual of actualIndexes) {
        const desired = desiredIndexesByName.get(actual.name.toLowerCase());
        if (!desired || indexSignature(desired) !== indexSignature(actual)) indexesToDrop.add(actual.name);
    }
    for (const name of indexesToDrop) {
        const dropSql = name.toUpperCase() === 'PRIMARY'
            ? `ALTER TABLE ${quotedTable} DROP PRIMARY KEY`
            : `ALTER TABLE ${quotedTable} DROP INDEX ${quoteIdentifier(name)}`;
        actions.push({ description: `Drop index ${table.name}.${name}`, sql: dropSql });
    }
    for (const desired of table.indexes) {
        const actual = actualIndexesByName.get(desired.name.toLowerCase());
        if (!actual || indexSignature(desired) !== indexSignature(actual)) {
            actions.push({
                description: `Add index ${table.name}.${desired.name}`,
                sql: `ALTER TABLE ${quotedTable} ADD ${desired.definition}`
            });
        }
    }

    if (table.engine && tableInfo.ENGINE && table.engine.toLowerCase() !== tableInfo.ENGINE.toLowerCase()) {
        actions.push({
            description: `Change engine for ${table.name} to ${table.engine}`,
            sql: `ALTER TABLE ${quotedTable} ENGINE=${table.engine}`
        });
    }
    const actualCharset = tableInfo.TABLE_COLLATION ? String(tableInfo.TABLE_COLLATION).split('_')[0] : null;
    if (table.charset && actualCharset && table.charset.toLowerCase() !== actualCharset.toLowerCase()) {
        actions.push({
            description: `Convert ${table.name} to ${table.charset}`,
            sql: `ALTER TABLE ${quotedTable} CONVERT TO CHARACTER SET ${table.charset}`
        });
    }
    return { actions, warnings };
}

async function captureStructure(db, tables) {
    const structure = {};
    for (const table of tables) {
        const info = await getTableInfo(db, table.name);
        if (!info) {
            structure[table.name] = { exists: false };
            continue;
        }
        const [columns] = await db.execute(`
            SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, ORDINAL_POSITION
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
            ORDER BY ORDINAL_POSITION
        `, [table.name]);
        const indexes = await getIndexes(db, table.name);
        structure[table.name] = {
            exists: true,
            engine: info.ENGINE,
            collation: info.TABLE_COLLATION,
            columns,
            indexes
        };
    }
    return structure;
}

async function ensureMigrationTables(db) {
    await db.execute(`
        CREATE TABLE IF NOT EXISTS schema_migration_state (
            id TINYINT UNSIGNED NOT NULL,
            schema_hash CHAR(64) NOT NULL,
            schema_sql LONGTEXT NOT NULL,
            structure JSON NOT NULL,
            status ENUM('running', 'applied', 'failed') NOT NULL,
            error_message TEXT NULL,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.execute(`
        CREATE TABLE IF NOT EXISTS schema_migration_history (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
            schema_hash CHAR(64) NOT NULL,
            schema_sql LONGTEXT NOT NULL,
            actions JSON NOT NULL,
            status ENUM('running', 'applied', 'failed') NOT NULL,
            before_structure JSON NOT NULL,
            after_structure JSON NULL,
            error_message TEXT NULL,
            started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            finished_at DATETIME NULL,
            PRIMARY KEY (id),
            KEY idx_schema_migration_hash (schema_hash),
            KEY idx_schema_migration_status (status, started_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}

async function applyDatabaseSchema(db, schemaPath) {
    const schemaSql = await fs.readFile(schemaPath, 'utf8');
    const schemaHash = crypto.createHash('sha256').update(schemaSql).digest('hex');
    const tables = parseCreateTables(schemaSql);
    await ensureMigrationTables(db);

    const beforeStructure = await captureStructure(db, tables);
    await db.execute(`
        UPDATE schema_migration_history
        SET status = 'failed',
            error_message = COALESCE(error_message, 'Migration process stopped before completion.'),
            finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP)
        WHERE status = 'running'
    `);
    const plans = await Promise.all(tables.map(table => buildMigrationActions(db, table)));
    const actions = plans.flatMap(plan => plan.actions);
    const warnings = plans.flatMap(plan => plan.warnings);
    for (const warning of warnings) console.warn(`[SCHEMA] ${warning}`);

    const [[state]] = await db.execute('SELECT schema_hash, status FROM schema_migration_state WHERE id = 1');
    if (actions.length === 0 && state && state.schema_hash === schemaHash && state.status === 'applied') {
        await db.execute(`
            UPDATE schema_migration_state
            SET schema_sql = ?, structure = ?, status = 'applied', error_message = NULL
            WHERE id = 1
        `, [schemaSql, JSON.stringify(beforeStructure)]);
        console.log('[SCHEMA] Database structure matches schema/database.sql.');
        return { changed: false, warnings };
    }

    const [historyInsert] = await db.execute(`
        INSERT INTO schema_migration_history
            (schema_hash, schema_sql, actions, status, before_structure)
        VALUES (?, ?, ?, 'running', ?)
    `, [schemaHash, schemaSql, JSON.stringify(actions), JSON.stringify(beforeStructure)]);
    await db.execute(`
        INSERT INTO schema_migration_state (id, schema_hash, schema_sql, structure, status, error_message)
        VALUES (1, ?, ?, ?, 'running', NULL)
        ON DUPLICATE KEY UPDATE
            schema_hash = VALUES(schema_hash), schema_sql = VALUES(schema_sql),
            structure = VALUES(structure), status = 'running', error_message = NULL
    `, [schemaHash, schemaSql, JSON.stringify(beforeStructure)]);

    try {
        for (const action of actions) {
            console.log(`[SCHEMA] ${action.description}`);
            await db.execute(action.sql);
        }
        const afterStructure = await captureStructure(db, tables);
        await db.execute(`
            UPDATE schema_migration_history
            SET status = 'applied', after_structure = ?, finished_at = CURRENT_TIMESTAMP
            WHERE id = ?
        `, [JSON.stringify(afterStructure), historyInsert.insertId]);
        await db.execute(`
            UPDATE schema_migration_state
            SET structure = ?, status = 'applied', error_message = NULL
            WHERE id = 1
        `, [JSON.stringify(afterStructure)]);
        console.log(`[SCHEMA] Applied ${actions.length} schema change(s).`);
        return { changed: actions.length > 0, warnings };
    } catch (error) {
        let afterStructure = beforeStructure;
        try { afterStructure = await captureStructure(db, tables); } catch { }
        const message = String(error.message || error).slice(0, 4000);
        try {
            await db.execute(`
                UPDATE schema_migration_history
                SET status = 'failed', after_structure = ?, error_message = ?, finished_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `, [JSON.stringify(afterStructure), message, historyInsert.insertId]);
            await db.execute(`
                UPDATE schema_migration_state
                SET structure = ?, status = 'failed', error_message = ?
                WHERE id = 1
            `, [JSON.stringify(afterStructure), message]);
        } catch (recordError) {
            console.error('[SCHEMA] Could not store migration failure:', recordError);
        }
        throw error;
    }
}

async function syncDatabaseSchema(db, schemaPath) {
    const lockConnection = await db.getConnection();
    let lockAcquired = false;
    try {
        const [[lock]] = await lockConnection.query("SELECT GET_LOCK('watcher_schema_migration', 30) AS acquired");
        lockAcquired = Number(lock.acquired) === 1;
        if (!lockAcquired) throw new Error('Timed out waiting for the database schema migration lock.');
        return await applyDatabaseSchema(db, schemaPath);
    } finally {
        if (lockAcquired) {
            try { await lockConnection.query("SELECT RELEASE_LOCK('watcher_schema_migration')"); } catch (error) {
                console.error('[SCHEMA] Could not release migration lock:', error);
            }
        }
        lockConnection.release();
    }
}

module.exports = { syncDatabaseSchema };
