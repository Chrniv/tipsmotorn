# Tipsmotorn data branch
- `fixtures.json`: open Stryktipset/Europatipset rounds, written by the `fixtures` GitHub Action every 30 minutes.
- `news/<round id>.json`: team news written by the scheduled Claude tasks. The Supabase collector imports a file when its `updatedAt` is newer.
