# Per-visitor Demo Sessions instead of one shared world

The demo is a public URL that prospects open on their own, often at the same time, so every visitor gets a private Demo Session: a fresh copy of the seed data, scoped by session id, that expires after a few hours. One global world with a reset button was rejected because one visitor's bookings and test escalations would show up on another visitor's dashboard mid-pitch, and a reset by one visitor would wipe another's demo. Under this model, "reset" means starting a new session.

## Consequences

- Every domain table carries a session id and every query must be scoped by it. A missed scope leaks one prospect's data into another's demo.
- Seed dates are generated relative to session creation time, so each session looks like a live business this week.
- A cleanup job deletes expired sessions; abuse limits (sessions per IP, messages per session) apply per session.
