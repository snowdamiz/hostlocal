# hostlocal

Minimal Tauri + SolidJS starter.

## SQLite wiring

SQLite is now initialized by the Tauri backend on startup.

- Database file: app data directory, `hostlocal.sqlite`
- Table: `messages (id, body, created_at)`

Available Tauri commands:

- `sqlite_healthcheck` -> returns `sqlite_version()`
- `sqlite_db_path` -> returns the absolute database path
- `sqlite_insert_message` -> args: `{ body: string }`, returns inserted row id
- `sqlite_list_messages` -> returns message bodies ordered by newest first

## GitHub authentication

This app uses GitHub OAuth Device Flow and does not require a client secret.

1. Create a GitHub OAuth App and enable Device Flow.
2. Configure the app's public GitHub OAuth client ID in the backend code.

Behavior:

- Unconnected: sidebar shows `Connect GitHub`
- Connected: sidebar shows avatar + username + sign-out icon button
- Access tokens are stored in the OS keychain (macOS Keychain / Windows Credential Manager / Linux Secret Service)
- Tokens are never stored in SQLite or committed files
- Tokens are cleared from keychain on sign-out

## Development

```bash
pnpm tauri dev
```
