export const LOGIN_WINDOW_MS = 10 * 60 * 1000;
export const LOGIN_LOCK_MS = 10 * 60 * 1000;
export const LOGIN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CLOCK = '(SELECT clock_ms FROM login_security_config WHERE id=1)';
const ENABLED = '(SELECT enabled FROM login_security_config WHERE id=1)=1';

function publicEvent(row) {
    return {
        id: row.id,
        type: row.type,
        createdAt: row.created_at,
        readAt: row.read_at,
        ip: row.ip,
        browser: row.browser,
        os: row.os,
        device: row.device,
        failedAttempts: row.failed_attempts,
        since: row.since,
        lastFailureAt: row.last_failure_at,
        target: 'security',
    };
}

export class LoginSecurityStore {
    constructor(db, now = Date.now) {
        // Primary reads prevent a replica from overlooking a newly created lock or config change.
        this.db = db.withSession ? db.withSession('first-primary') : db;
        this.now = now;
    }
    q(sql, ...params) {
        return this.db.prepare(sql).bind(...params);
    }
    async config(ip = null) {
        const config = await this.q(
            'SELECT c.*,i.locked_until FROM login_security_config c LEFT JOIN login_security_ips i ON i.ip=? WHERE c.id=1',
            ip
        ).first();
        if (!config || config.schema_version !== 1 || ![0, 1].includes(config.enabled)) {
            throw new Error('login_security_schema_unavailable');
        }
        return config;
    }
    clock() {
        return this.q(
            'UPDATE login_security_config SET clock_ms=MAX(clock_ms,?) WHERE id=1',
            this.now()
        );
    }
    cleanup() {
        return [
            this.q(
                `DELETE FROM login_security_failures WHERE created_at<=${CLOCK}-?`,
                LOGIN_RETENTION_MS
            ),
            this.q(
                `DELETE FROM login_security_events WHERE created_at<=${CLOCK}-?`,
                LOGIN_RETENTION_MS
            ),
            this.q(
                `DELETE FROM login_security_ips WHERE updated_at<=${CLOCK}-? AND locked_until<=${CLOCK}`,
                LOGIN_RETENTION_MS
            ),
        ];
    }
    async record(ip, matched, device = {}) {
        const operation = crypto.randomUUID();
        const reset = `login_security_ips.failures=0 OR login_security_ips.window_started_at<=${CLOCK}-${LOGIN_WINDOW_MS} OR login_security_ips.locked_until>0`;
        const admitted = `EXISTS(SELECT 1 FROM login_security_ips WHERE ip=? AND operation_id=?) AND ${ENABLED}`;
        // One D1 batch is one transaction: admission, count, audit and warning consumption
        // cannot interleave with another attempt. A rejected lock keeps its original expiry.
        const statements = [
            this.clock(),
            ...this.cleanup(),
            this.q(
                `INSERT INTO login_security_ips(ip,failures,window_started_at,locked_until,updated_at,operation_id)
                SELECT ?,?,${CLOCK},0,${CLOCK},? WHERE ${ENABLED}
                ON CONFLICT(ip) DO UPDATE SET
                    failures=CASE WHEN ? THEN 0 WHEN ${reset} THEN 1 ELSE login_security_ips.failures+1 END,
                    window_started_at=CASE WHEN ? OR ${reset} THEN ${CLOCK} ELSE login_security_ips.window_started_at END,
                    locked_until=CASE WHEN ? OR ${reset} THEN 0 WHEN login_security_ips.failures=9 THEN ${CLOCK}+${LOGIN_LOCK_MS} ELSE 0 END,
                    updated_at=${CLOCK},operation_id=excluded.operation_id
                WHERE login_security_ips.locked_until<=${CLOCK}`,
                ip,
                matched ? 0 : 1,
                operation,
                +matched,
                +matched,
                +matched
            ),
        ];
        if (matched) {
            statements.push(
                this.q(
                    `INSERT INTO login_security_events(operation_id,type,created_at,failed_attempts,since,last_failure_at)
                    SELECT ?,'login_warning',${CLOCK},COUNT(*),MIN(created_at),MAX(created_at)
                    FROM login_security_failures WHERE ${admitted} HAVING COUNT(*)>0`,
                    operation,
                    ip,
                    operation
                ),
                this.q(`DELETE FROM login_security_failures WHERE ${admitted}`, ip, operation),
                this.q(
                    `INSERT INTO login_security_events(operation_id,type,created_at,ip,browser,os,device)
                    SELECT ?,'login_success',${CLOCK},?,?,?,? WHERE ${admitted}`,
                    operation,
                    ip,
                    device.browser,
                    device.os,
                    device.device,
                    ip,
                    operation
                )
            );
        } else {
            statements.push(
                this.q(
                    `INSERT INTO login_security_failures(created_at) SELECT ${CLOCK} WHERE ${admitted}`,
                    ip,
                    operation
                )
            );
        }
        statements.push(
            this.q('SELECT enabled,clock_ms FROM login_security_config WHERE id=1'),
            this.q('SELECT locked_until,operation_id FROM login_security_ips WHERE ip=?', ip),
            this.q(
                "SELECT * FROM login_security_events WHERE operation_id=? AND type='login_warning'",
                operation
            )
        );
        const result = await this.db.batch(statements);
        const config = result.at(-3).results[0];
        const state = result.at(-2).results[0];
        const warning = result.at(-1).results[0];
        return {
            enabled: config.enabled === 1,
            lockedUntil:
                config.enabled && state?.locked_until > config.clock_ms ? state.locked_until : null,
            warning: warning
                ? {
                      id: warning.id,
                      failedAttempts: warning.failed_attempts,
                      since: warning.since,
                      lastFailureAt: warning.last_failure_at,
                  }
                : null,
        };
    }
    async list({ before = null, limit = 20, audit = false } = {}) {
        const filter = audit ? "AND type='login_success'" : '';
        const result = await this.db.batch([
            this.clock(),
            ...this.cleanup(),
            this.q(
                `SELECT * FROM login_security_events WHERE ${ENABLED} AND (? IS NULL OR id<?) ${filter} ORDER BY id DESC LIMIT ?`,
                before,
                before,
                limit + 1
            ),
            this.q(
                `SELECT COUNT(*) AS count FROM login_security_events WHERE ${ENABLED} AND read_at IS NULL ${filter}`
            ),
            this.q('SELECT enabled FROM login_security_config WHERE id=1'),
        ]);
        const rows = result.at(-3).results;
        const items = rows.slice(0, limit).map(publicEvent);
        return {
            enabled: result.at(-1).results[0].enabled === 1,
            items,
            unreadCount: result.at(-2).results[0].count,
            nextCursor: rows.length > limit ? items.at(-1).id : null,
        };
    }
    async markRead(ids) {
        const result = await this.db.batch([
            this.clock(),
            ...this.cleanup(),
            this.q(
                `UPDATE login_security_events SET read_at=COALESCE(read_at,${CLOCK}) WHERE ${ENABLED} AND id IN (SELECT value FROM json_each(?))`,
                JSON.stringify([...new Set(ids)])
            ),
            this.q('SELECT enabled FROM login_security_config WHERE id=1'),
        ]);
        return result.at(-1).results[0].enabled === 1;
    }
}
