# NEXUS Calendar

Installable, offline calendar in the NEXUS style: month / week / day / list views, quick add ("math test fri 9am"), homework checklist, search, US holidays, JSON backup, and reminder push notifications.

Live: https://olivercraftboycompany-design.github.io/NEXUS-Calendar/

- Events are stored on your device (localStorage). Back up from ⚙️ Settings.
- Reminders: the phone subscribes to Web Push (VAPID) and posts a sealed (encrypted) copy of only the events that have reminders to a private ntfy topic. `.github/workflows/calendar-reminders.yml` checks every minute (a "watch" job that hands off to the next run itself; cron is only a backstop) and sends each reminder at its time.
