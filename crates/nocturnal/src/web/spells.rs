//! Ziglax's spell turn-in tracker (github.com/Ziglax/nocturnal-spells), served
//! at `/spells/` (2026-09-30).
//!
//! The page itself is vendored unchanged from his repo (`spells/`, MIT) and
//! baked into the binary. What his PHP backend did is done here instead, on
//! the same four URLs his script already calls, so a fresh copy of his files
//! drops in without edits:
//!
//! - `api/me.php` names the viewer: the site's Discord login (Perses, the
//!   same whoami the drop zone asks) instead of his own OAuth app, and `write`
//!   for an officer (the guild's admin role or Discord Administrator, the rule
//!   every officer command uses), `read` for everyone else behind the wall.
//! - `api/state.php` is his one shared JSON document: `GET` for anyone, `POST`
//!   for officers with his optimistic lock (`rev`; a stale one gets 409 and
//!   the current document) and his `X-Spelltracker: 1` CSRF header. It lives
//!   in `<data dir>/spells-state.json`, beside the ledger and in its backups.
//! - `api/login.php` sends the browser to the site's Discord sign-in;
//!   `api/logout.php` has nothing of its own to end (the site's session is
//!   Perses's) and just answers.
//!
//! Caddy keeps the page behind the login wall and `api/*` behind the XHR
//! wall, like `/upload`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use poise::serenity_prelude as serenity;

use super::upload::Head;
use super::Response;

/// His bound on the state body (`state.php`), kept so a document that fits
/// his host fits here.
pub const MAX_BODY: usize = 2_100_000;

/// How long a viewer's officer answer is trusted before Discord is asked
/// again. His sessions pinned the role for 7 days; a minute is plenty to
/// spare Discord a request per save while a demotion still bites quickly.
const ROLE_TTL: Duration = Duration::from_secs(60);

const INDEX: &[u8] = include_bytes!("spells/index.html");
const APP_JS: &[u8] = include_bytes!("spells/app.js");
const STYLES: &[u8] = include_bytes!("spells/styles.css");
const SPELLS_JS: &[u8] = include_bytes!("spells/data/spells.js");
const POK_MAP_JS: &[u8] = include_bytes!("spells/data/pok_map.js");
const LICENSE: &[u8] = include_bytes!("spells/LICENSE");

/// Everything the endpoints need, built once at startup.
pub struct SpellsCtx {
    pub rt: tokio::runtime::Handle,
    pub site: crate::site::SiteHandle,
    pub driver: crate::driver::DriverHandle,
    pub http: std::sync::Arc<serenity::Http>,
    /// The Discord server whose roles make an officer.
    pub discord_guild: u64,
    /// The ledger guild whose `admin_role` is the officer role.
    pub ledger_guild: u64,
    pub state_path: PathBuf,
    /// Serialises read-modify-write of the state file.
    pub lock: Mutex<()>,
    roles: Mutex<HashMap<u64, (Instant, bool)>>,
}

impl SpellsCtx {
    pub fn new(
        rt: tokio::runtime::Handle,
        site: crate::site::SiteHandle,
        driver: crate::driver::DriverHandle,
        http: std::sync::Arc<serenity::Http>,
        discord_guild: u64,
        ledger_guild: u64,
        data_dir: &std::path::Path,
    ) -> Self {
        SpellsCtx {
            rt,
            site,
            driver,
            http,
            discord_guild,
            ledger_guild,
            state_path: data_dir.join("spells-state.json"),
            lock: Mutex::new(()),
            roles: Mutex::new(HashMap::new()),
        }
    }
}

/// The page and its files, for a `GET` under `/spells`. `None` when the path
/// is not one of them.
pub fn static_file(path: &str) -> Option<Response> {
    let (body, content_type): (&[u8], &'static str) = match path {
        "/spells" => {
            // His script calls `api/...` relative to the page, so the page
            // must be a directory URL.
            return Some(Response {
                status: "301 Moved Permanently",
                content_type: "text/plain; charset=utf-8",
                body: Vec::new(),
                headers: vec!["location: /spells/".into()],
            });
        }
        "/spells/" | "/spells/index.html" => (PAGE.as_bytes(), "text/html; charset=utf-8"),
        "/spells/app.js" => (APP_JS, "text/javascript; charset=utf-8"),
        "/spells/styles.css" => (STYLES, "text/css; charset=utf-8"),
        "/spells/data/spells.js" => (SPELLS_JS, "text/javascript; charset=utf-8"),
        "/spells/data/pok_map.js" => (POK_MAP_JS, "text/javascript; charset=utf-8"),
        "/spells/LICENSE" => (LICENSE, "text/plain; charset=utf-8"),
        "/spells/config.json" => {
            // Only guildName is read by the page; the ids his PHP needed are
            // this server's business, not the browser's. Empty, because the
            // site bar above his header already says Nocturnal.
            return Some(json("200 OK", serde_json::json!({ "guildName": "" })));
        }
        _ => return None,
    };
    Some(Response {
        status: "200 OK",
        content_type,
        body: body.to_vec(),
        headers: vec!["cache-control: no-cache, must-revalidate".into()],
    })
}

/// His page inside ours: the site's bar on top, the site's fonts, favicon and
/// light/dark palette, with his files untouched on disk. His stylesheet reads
/// its colours from a dozen variables, so re-pointing those at the site's
/// tokens re-themes it; the few literals he wrote are overridden by hand.
static PAGE: LazyLock<String> = LazyLock::new(|| {
    let index = std::str::from_utf8(INDEX).expect("index.html is UTF-8");
    let head = maud::html! {
        link rel="icon" href=(super::pages::FAVICON);
        link rel="stylesheet" href=(super::pages::FONTS);
    }
    .into_string();
    let css = shell_css();
    let nav = super::pages::site_nav("spells").into_string();
    index
        .replacen(
            "<title>Spell Turn-ins</title>",
            "<title>Spells · Nocturnal</title>",
            1,
        )
        .replacen(
            r#"<link rel="stylesheet" href="styles.css">"#,
            &format!(r#"<link rel="stylesheet" href="styles.css">{head}<style>{css}</style>"#),
            1,
        )
        .replacen("<body>", &format!("<body>{nav}"), 1)
        .replacen(
            "</body>",
            &format!("<script>{}</script></body>", super::pages::PAGE_JS),
            1,
        )
});

/// The site's tokens and nav rules, lifted from its stylesheet so the two
/// never drift, plus the mapping of his variables onto them.
fn shell_css() -> String {
    let site = super::pages::CSS;
    let keep = |l: &&str| {
        l.starts_with(":root")
            || l.starts_with("@media (prefers-color-scheme")
            || l.starts_with("nav")
            || l.starts_with(".namelink")
            || l.starts_with("#tip")
    };
    let mut css: String = site
        .lines()
        .filter(keep)
        .map(|l| {
            l.replace("nav{", "nav.site{")
                .replace("nav .", "nav.site .")
                .replace("nav a.", "nav.site a.")
                + "\n"
        })
        .collect();
    css.push_str(SPELLS_THEME);
    css
}

const SPELLS_THEME: &str = r#"
:root{--bg:var(--ground);--bg-raised:var(--surface);--bg-inset:var(--surface-2);--border:var(--line);--border-strong:var(--line-strong);--text-dim:var(--muted);--gold:var(--brass);--gold-dim:var(--line-strong);--ok:var(--good);--bad:var(--low);--spectral:#1F6F99;--glyphed:#6A4FB8;font-size:16px}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--spectral:#7DD3FC;--glyphed:#C4B5FD}}
:root[data-theme="dark"]{--spectral:#7DD3FC;--glyphed:#C4B5FD}
body{background:var(--ground);background-image:none;font:16px/1.55 "Atkinson Hyperlegible",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
nav.site{margin:0 -16px}
.brand h1{font-family:"Cormorant Garamond",Georgia,serif;font-size:2rem;color:var(--text)}
.brand h1 .app-name{color:var(--text)}
.btn{color:var(--surface)}
.btn.ghost{color:var(--muted)}
#user-chip>span:first-child,#user-chip>button{display:none}
.tabs button.active{color:var(--text);border-bottom-color:var(--brass);font-weight:700}
tr.clickable:hover td{background:var(--surface-2)}
.badge.spectral,.chip.spectral.selected{background:color-mix(in srgb,var(--spectral) 13%,transparent)}
.badge.glyphed,.chip.glyphed.selected{background:color-mix(in srgb,var(--glyphed) 14%,transparent)}
.badge.prio,.chip.selected{background:color-mix(in srgb,var(--brass) 14%,transparent)}
.badge.ok{background:color-mix(in srgb,var(--good) 13%,transparent)}
.badge.warn{background:color-mix(in srgb,var(--warn) 13%,transparent)}
.badge.bad{background:color-mix(in srgb,var(--low) 13%,transparent)}
.badge.dim{background:color-mix(in srgb,var(--muted) 13%,transparent)}
.map-tip .map-label{fill:var(--muted)}
.map-tip .map-marker{stroke:var(--surface)}
#help-dialog::backdrop{background:rgba(0,0,0,.5)}
"#;

fn json(status: &'static str, v: serde_json::Value) -> Response {
    Response {
        status,
        content_type: "application/json; charset=utf-8",
        body: v.to_string().into_bytes(),
        headers: vec!["cache-control: no-store".into()],
    }
}

fn error(status: &'static str, message: &str) -> Response {
    json(status, serde_json::json!({ "error": message }))
}

/// The shared document, exactly the shape his PHP stored and served.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Doc {
    pub rev: i64,
    pub state: serde_json::Value,
    #[serde(rename = "updatedAt")]
    pub updated_at: Option<String>,
    #[serde(rename = "updatedBy")]
    pub updated_by: Option<String>,
}

impl Doc {
    fn empty() -> Self {
        Doc {
            rev: 0,
            state: serde_json::Value::Null,
            updated_at: None,
            updated_by: None,
        }
    }
}

/// What a save attempt comes to, decided without touching the disk.
#[derive(Debug, PartialEq)]
pub enum Save {
    /// The client edited an older revision: here is the current document.
    Conflict(Doc),
    /// The document to write.
    Saved(Doc),
}

/// His optimistic lock: a save based on the current revision replaces the
/// state and bumps the revision; anything else is a conflict.
pub fn apply_save(current: &Doc, rev: i64, state: serde_json::Value, by: &str, now: &str) -> Save {
    if rev != current.rev {
        return Save::Conflict(current.clone());
    }
    Save::Saved(Doc {
        rev: current.rev + 1,
        state,
        updated_at: Some(now.to_owned()),
        updated_by: Some(by.to_owned()),
    })
}

/// Read the document. A missing or empty file is the empty document; an
/// unreadable one is an error, never silently replaced (his rule: that would
/// wipe the tracker).
pub fn read_doc(path: &std::path::Path) -> Result<Doc, String> {
    match std::fs::read_to_string(path) {
        Ok(raw) if raw.trim().is_empty() => Ok(Doc::empty()),
        Ok(raw) => serde_json::from_str(&raw).map_err(|_| {
            "spells-state.json exists but is not valid; refusing to touch it.".to_owned()
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Doc::empty()),
        Err(e) => Err(format!("could not read the state file: {e}")),
    }
}

/// Write the document atomically: a temp file renamed over the old one.
pub fn write_doc(path: &std::path::Path, doc: &Doc) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(doc).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, bytes).map_err(|e| format!("could not write the state file: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("could not write the state file: {e}"))
}

/// Who is asking: the ledger player (Discord id) and the site's name for
/// them, from the Perses login behind the request's cookies.
struct Viewer {
    id: u64,
    name: String,
}

fn viewer(ctx: &SpellsCtx, head: &Head) -> Option<Viewer> {
    let cookie = head.cookie.as_deref()?;
    let login = ctx.rt.block_on(super::upload::whoami(cookie))?;
    let snapshot = ctx.site.read().ok().and_then(|s| s.clone());
    let id = snapshot
        .as_ref()
        .and_then(|s| s.logins.get(&login.to_lowercase()).copied())
        .unwrap_or(0);
    let name = snapshot
        .as_ref()
        .and_then(|s| s.members.get(&login).map(|m| m.name.clone()))
        .unwrap_or(login);
    Some(Viewer { id, name })
}

/// Is this player an officer: the guild's configured admin role, or a role
/// with Discord Administrator. The answer is kept for [`ROLE_TTL`].
fn is_officer(ctx: &SpellsCtx, player: u64) -> bool {
    if player == 0 {
        return false;
    }
    if let Ok(cache) = ctx.roles.lock() {
        if let Some((at, answer)) = cache.get(&player) {
            if at.elapsed() < ROLE_TTL {
                return *answer;
            }
        }
    }
    let ledger_guild = ctx.ledger_guild;
    let admin_role = ctx.rt.block_on(ctx.driver.query(move |l| {
        l.state()
            .guild(ledger_guild)
            .and_then(|g| g.config.admin_role)
    }));
    let guild = serenity::GuildId::new(ctx.discord_guild);
    let answer = ctx.rt.block_on(async {
        let Ok(member) = ctx
            .http
            .get_member(guild, serenity::UserId::new(player))
            .await
        else {
            return false;
        };
        if admin_role.is_some_and(|r| member.roles.iter().any(|x| x.get() == r)) {
            return true;
        }
        let Ok(roles) = ctx.http.get_guild_roles(guild).await else {
            return false;
        };
        roles
            .iter()
            .any(|r| member.roles.contains(&r.id) && r.permissions.administrator())
    });
    if let Ok(mut cache) = ctx.roles.lock() {
        cache.insert(player, (Instant::now(), answer));
    }
    answer
}

/// One request under `/spells/api/`.
pub fn handle(ctx: &SpellsCtx, head: &Head, body: &[u8]) -> Response {
    let path = head.path.split('?').next().unwrap_or("");
    match (head.method.as_str(), path) {
        ("GET", "/spells/api/login.php") => Response {
            status: "302 Found",
            content_type: "text/plain; charset=utf-8",
            body: Vec::new(),
            headers: vec![
                "location: /perses/api/auth/providers/oauth/discord/login?rd=%2Fspells%2F".into(),
            ],
        },
        // The session is the site's own; there is nothing here to end.
        ("POST", "/spells/api/logout.php") => json("200 OK", serde_json::json!({ "ok": true })),
        ("GET", "/spells/api/me.php") => {
            let Some(v) = viewer(ctx, head) else {
                return error("401 Unauthorized", "Not authenticated.");
            };
            let perm = if is_officer(ctx, v.id) {
                "write"
            } else {
                "read"
            };
            json(
                "200 OK",
                serde_json::json!({
                    "user": { "id": v.id.to_string(), "name": v.name },
                    "perm": perm,
                    "expiresAt": serde_json::Value::Null,
                }),
            )
        }
        ("GET", "/spells/api/state.php") => {
            if viewer(ctx, head).is_none() {
                return error("401 Unauthorized", "Not authenticated.");
            }
            let _guard = ctx.lock.lock();
            match read_doc(&ctx.state_path) {
                Ok(doc) => json("200 OK", serde_json::to_value(doc).unwrap_or_default()),
                Err(e) => error("500 Internal Server Error", &e),
            }
        }
        ("POST", "/spells/api/state.php") => {
            let Some(v) = viewer(ctx, head) else {
                return error("401 Unauthorized", "Not authenticated.");
            };
            if !is_officer(ctx, v.id) {
                return error("403 Forbidden", "Read-only access.");
            }
            if !head.spelltracker {
                return error("400 Bad Request", "Missing request header.");
            }
            let parsed: Option<(i64, serde_json::Value)> =
                serde_json::from_slice::<serde_json::Value>(body)
                    .ok()
                    .and_then(|b| {
                        Some((
                            b.get("rev")?.as_i64()?,
                            b.get("state").filter(|s| s.is_object())?.clone(),
                        ))
                    });
            let Some((rev, state)) = parsed else {
                return error(
                    "400 Bad Request",
                    "Body must be {\"rev\": int, \"state\": object}.",
                );
            };
            let _guard = ctx.lock.lock();
            let current = match read_doc(&ctx.state_path) {
                Ok(d) => d,
                Err(e) => return error("500 Internal Server Error", &e),
            };
            let now =
                crate::raid_names::rfc3339(crate::discord::chrono_now_ms()).unwrap_or_default();
            match apply_save(&current, rev, state, &v.name, &now) {
                Save::Conflict(doc) => json(
                    "409 Conflict",
                    serde_json::to_value(doc).unwrap_or_default(),
                ),
                Save::Saved(doc) => match write_doc(&ctx.state_path, &doc) {
                    Ok(()) => json(
                        "200 OK",
                        serde_json::json!({ "rev": doc.rev, "updatedAt": doc.updated_at }),
                    ),
                    Err(e) => error("500 Internal Server Error", &e),
                },
            }
        }
        _ => Response::not_found(),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn the_page_and_its_files_are_served_and_the_bare_path_redirects() {
        let r = static_file("/spells").unwrap();
        assert_eq!(r.status, "301 Moved Permanently");
        assert!(r.headers.iter().any(|h| h == "location: /spells/"));
        for (path, ty) in [
            ("/spells/", "text/html"),
            ("/spells/app.js", "text/javascript"),
            ("/spells/styles.css", "text/css"),
            ("/spells/data/spells.js", "text/javascript"),
            ("/spells/data/pok_map.js", "text/javascript"),
        ] {
            let r = static_file(path).unwrap();
            assert_eq!(r.status, "200 OK", "{path}");
            assert!(r.content_type.starts_with(ty), "{path}");
            assert!(!r.body.is_empty(), "{path}");
        }
        assert!(static_file("/spells/api/secrets.php").is_none());
        assert!(static_file("/spells/../Cargo.toml").is_none());
    }

    #[test]
    fn the_page_wears_the_site_bar_and_palette() {
        let r = static_file("/spells/").unwrap();
        let page = String::from_utf8(r.body).unwrap();
        // Every replacement found its anchor in his index.html.
        assert!(page.contains("<title>Spells · Nocturnal</title>"));
        let nav = page.find(r#"<nav class="site">"#).unwrap();
        assert!(nav < page.find(r#"class="app-header""#).unwrap());
        assert!(page.contains(r#"href="/spells/" aria-current="page""#));
        assert!(page.contains(r#"href="/roster""#));
        assert!(page.contains("nav.site .in{"));
        assert!(page.contains("--gold:var(--brass)"));
        assert!(page.contains(r#":root[data-theme="dark"]{--ground:"#));
        assert!(page.contains("whoami"));
        assert!(page.find("whoami").unwrap() < page.find("</body>").unwrap());
        // No bare nav rule escapes onto his tab bar.
        assert!(!page.contains("\nnav{"));
    }

    #[test]
    fn config_carries_only_the_guild_name() {
        let r = static_file("/spells/config.json").unwrap();
        let v: serde_json::Value = serde_json::from_slice(&r.body).unwrap();
        assert_eq!(v, serde_json::json!({ "guildName": "" }));
    }

    #[test]
    fn a_save_on_the_current_revision_bumps_it_and_names_the_officer() {
        let current = Doc::empty();
        let state = serde_json::json!({ "turnins": [1] });
        match apply_save(&current, 0, state.clone(), "Ziglax", "2026-09-30T18:00:00Z") {
            Save::Saved(doc) => {
                assert_eq!(doc.rev, 1);
                assert_eq!(doc.state, state);
                assert_eq!(doc.updated_by.as_deref(), Some("Ziglax"));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_save_on_a_stale_revision_is_a_conflict_with_the_current_doc() {
        let current = Doc {
            rev: 5,
            state: serde_json::json!({ "a": 1 }),
            updated_at: Some("x".into()),
            updated_by: Some("Bubblie".into()),
        };
        assert_eq!(
            apply_save(&current, 4, serde_json::json!({}), "Ziglax", "now"),
            Save::Conflict(current.clone())
        );
    }

    #[test]
    fn the_document_round_trips_through_the_file_and_a_missing_file_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("spells-state.json");
        assert_eq!(read_doc(&path).unwrap(), Doc::empty());
        let doc = Doc {
            rev: 3,
            state: serde_json::json!({ "classes": ["Cleric"] }),
            updated_at: Some("2026-09-30T18:00:00Z".into()),
            updated_by: Some("Ziglax".into()),
        };
        write_doc(&path, &doc).unwrap();
        assert_eq!(read_doc(&path).unwrap(), doc);
        // His wire shape: camelCase timestamps, the state as sent.
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["updatedBy"], "Ziglax");
        assert_eq!(v["rev"], 3);
    }

    #[test]
    fn an_unreadable_document_is_refused_not_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("spells-state.json");
        std::fs::write(&path, "{ not json").unwrap();
        assert!(read_doc(&path).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not json");
    }
}
