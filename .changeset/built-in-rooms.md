---
'@iwer/sem': minor
'@iwer/devui': minor
'iwer': minor
---

Add eight built-in GLTS rooms to `@iwer/sem` (`sunlit_living_room`, `home_office`, `conference_room`, `open_office`, `kitchen`, `bedroom`, `music_studio`, `open_studio`), each within Quest's 10 x 10 m room-scan limit and reported like a scanned room. `sem.environments` lists them first and `sem.environmentInfo(id)` tells rooms, added environments and legacy scans apart; the DevUI environment menu lists the room captures under "Legacy scans". The iwer `SyntheticEnvironmentModule` interface gains an optional `environmentInfo`. The rooms add about 0.3 MB to the package (2.8 MB packed); apps load only the room they pick.
