# Security Policy

## Reporting a vulnerability

Please do not report security vulnerabilities through public GitHub issues.

Meta has a [bug bounty program](https://bugbounty.meta.com/) for the safe disclosure of security bugs. Report
vulnerabilities in any package of this repository (`iwer`, `@iwer/devui`, `@iwer/sem`, `@iwer/extension-bridge`,
`@iwer/native` and the browser extension) through that program and follow the process described there.

## Supported versions

Security fixes go into the latest published version of each package. `@iwer/native` is an experimental alpha
and is not production ready; see its [README](packages/native/README.md).

## Notes for `@iwer/native`

- Debug builds (the default of `iwer-native pack`) serve a V8 inspector and a debug endpoint that can run code
  in the app. They listen on an abstract socket that only `adb` and the app itself can open. Do not distribute
  debug builds; ship release builds (`iwer-native pack --release`), which serve neither unless packed with
  `--inspector`.
- Release signing keys stay on your machine: the packer reads the keystore from the path in your config and the
  passwords from environment variables, and never writes either into the APK or the project.
