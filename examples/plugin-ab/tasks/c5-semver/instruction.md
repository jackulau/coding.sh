Our release dashboard sorts `1.10.0` before `1.9.0` and puts `2.0.0-beta.2` after `2.0.0`.
`compareVersions(a, b)` in `src/semver.js` should follow semver precedence (numeric parts compare as
numbers, a prerelease sorts before its release, prerelease identifiers compare per the spec, build
metadata is ignored). Fix it and say what was wrong.
