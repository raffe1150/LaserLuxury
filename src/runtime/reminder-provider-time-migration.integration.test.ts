import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const commands = ["initdb", "pg_ctl", "psql"];
const hasLocalPostgres = commands.every(command => {
  try { execFileSync(command, ["--version"], { stdio: "pipe" }); return true; }
  catch { return false; }
});

test("migration marks existing Meta inbound rows once; new/backdated inserts never inherit compatibility", {
  skip: hasLocalPostgres ? false : "local PostgreSQL binaries unavailable",
  timeout: 45_000,
}, () => {
  // Private disposable cluster; no TCP listener or production database settings.
  const directory = mkdtempSync(join(tmpdir(), "odinlink-reminder-cutover-"));
  const data = join(directory, "data");
  const socket = join(directory, "socket");
  const env = { PATH: process.env.PATH, LANG: "C", LC_ALL: "C" };
  const execute = (command: string, args: string[]) => execFileSync(command, args, {
    env, encoding: "utf8", stdio: "pipe", timeout: 20_000,
  }).trim();
  const psqlArgs = ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1",
    "-h", socket, "-p", "55439", "-U", "odinlink_reminder_test", "-d", "postgres"];
  const query = (sql: string) => execute("psql", [...psqlArgs, "-c", sql]);
  const migration = fileURLToPath(new URL(
    "../../supabase/migrations/20261004130125_add_chat_history_provider_event_time.sql", import.meta.url,
  ));
  let initialized = false;
  try {
    mkdirSync(socket);
    execute("initdb", ["-D", data, "--no-locale", "--encoding=UTF8",
      "--auth-local=trust", "--auth-host=reject", "-U", "odinlink_reminder_test"]);
    initialized = true;
    appendFileSync(join(data, "postgresql.conf"),
      `\nlisten_addresses = ''\nport = 55439\nunix_socket_directories = '${socket}'\ntimezone = 'UTC'\n`);
    execute("pg_ctl", ["-D", data, "-l", join(directory, "postgres.log"), "-w", "start"]);
    query(`
      create table public.chat_history (
        id integer primary key, business_id bigint, platform text, user_id text,
        sender text, created_at timestamptz default now(), provider_event_at timestamptz
      );
      insert into public.chat_history (id,business_id,platform,user_id,sender,created_at) values
        (1,7,'whatsapp','customer-7','user',now()-interval '1 hour'),
        (2,7,'messenger','customer-7','user',now()-interval '1 hour'),
        (3,7,'instagram','customer-7','customer',now()-interval '1 hour'),
        (4,7,'telegram','customer-7','user',now()-interval '1 hour'),
        (5,7,'whatsapp','customer-7','bot',now()-interval '1 hour'),
        (6,7,'whatsapp','customer-7','human',now()-interval '1 hour'),
        (7,7,'whatsapp','customer-7','user',now()+interval '1 hour'),
        (8,7,'whatsapp','customer-7','user',now()-interval '1 hour'),
        (9,8,'whatsapp','customer-8','user',now()-interval '1 hour'),
        (12,7,'whatsapp','customer-7','user',now()-interval '25 hours');
      update public.chat_history set provider_event_at=created_at where id=8;
    `);
    const providerBefore = query("select provider_event_at from public.chat_history where id=8");
    execute("psql", [...psqlArgs, "-f", migration]);
    assert.equal(query(`select string_agg(id::text,',' order by id) from public.chat_history
      where reminder_provider_time_cutover_at is not null`), "1,2,3,9");
    assert.equal(query("select count(distinct reminder_provider_time_cutover_at) from public.chat_history"), "1");
    assert.equal(query(`select bool_and(created_at < reminder_provider_time_cutover_at)
      from public.chat_history where reminder_provider_time_cutover_at is not null`), "t");
    assert.equal(query("select provider_event_at from public.chat_history where id=8"), providerBefore);
    assert.equal(query("select count(*) from public.chat_history where provider_event_at is not null"), "1",
      "migration never reconstructs historical provider timestamps");
    const cutover = query("select reminder_provider_time_cutover_at from public.chat_history where id=1");
    query(`insert into public.chat_history (id,business_id,platform,user_id,sender,created_at) values
      (10,7,'whatsapp','customer-7','user',clock_timestamp()),
      (11,7,'whatsapp','customer-7','user',(select reminder_provider_time_cutover_at
        from public.chat_history where id=1)-interval '1 hour')`);
    assert.equal(query(`select count(*) from public.chat_history where id in (10,11)
      and provider_event_at is null and reminder_provider_time_cutover_at is null`), "2",
    "new persistence and backdated inserts both lack legacy proof");
    execute("psql", [...psqlArgs, "-f", migration]);
    assert.equal(query("select reminder_provider_time_cutover_at from public.chat_history where id=1"), cutover,
      "migration replay never resets expiration");
    assert.equal(query("select count(*) from public.chat_history where reminder_provider_time_cutover_at is not null"), "4",
      "migration replay never marks new rows");
  } finally {
    if (initialized) {
      try { execute("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]); } catch { /* Already stopped. */ }
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
