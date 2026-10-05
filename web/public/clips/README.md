# Demo clips

Drop short face-blurred files in this folder. The app does not play them yet.

Served locally and on Firebase Hosting as `/clips/<filename>`. Git ignores `*.mp4`, `*.webm`, and `*.mov`, so the videos stay on this machine until you upload them.

Suggested names, one per camera:

| File | Camera |
|---|---|
| `lane-1.mp4` | Self-checkout · Lane 1 |
| `lane-2.mp4` | Self-checkout · Lane 2 |
| `aisle-4.mp4` | Aisle 4 · Spirits |
| `aisle-2.mp4` | Aisle 2 · Snacks |

Keep each file under 25 MB. Synthetic or consented footage only.

When you are ready to keep them for judges, upload the same files to `gs://shrinksight-app-evidence/seed/` (project `shrinksight-app`, `us-central1`). Leave `seed/` off the 24-hour delete rule. Live investigation clips go in `evidence/` and can expire.
