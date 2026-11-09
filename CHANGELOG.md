# Changelog

## [0.3.0](https://github.com/yorch/crewplane/compare/v0.2.0...v0.3.0) (2026-11-09)


### Features

* **cli:** add verified self-update and background update checks ([adc5340](https://github.com/yorch/crewplane/commit/adc53408e70d1a3ad8cd06e006188e308a9c263f))
* **harness:** add Claude Code and OpenCode adapters ([957319a](https://github.com/yorch/crewplane/commit/957319a3eb21fe0174319c10c4bcf522d87f8657))
* **project:** enforce native version pins and compose agent prompts ([03fc877](https://github.com/yorch/crewplane/commit/03fc87710bcf5b6cbcfd7913fa8af11fff7f5e52))
* **release:** harden the installer and cover self-update end to end ([9bfb669](https://github.com/yorch/crewplane/commit/9bfb6699688bd23771845aaf9d1b14fc05001666))


### Bug Fixes

* **cli:** harden self-update against adversarial review ([f46359b](https://github.com/yorch/crewplane/commit/f46359b747c255d601cb5e70c58ab6aa0c99e6c6))
* **cli:** report invalid JSON input clearly ([656e09a](https://github.com/yorch/crewplane/commit/656e09a8e60dd7f1888bea911f8c7f5d971f102c))
* **release:** repair installer argument loop and signal handling ([27e8446](https://github.com/yorch/crewplane/commit/27e8446d7f48c3b30c6a25975f8c8d9722c2d16c))

## [0.2.0](https://github.com/yorch/crewplane/compare/v0.1.0...v0.2.0) (2026-11-08)


### Features

* **dashboard:** redesign operations views and navigation ([e5dbf3a](https://github.com/yorch/crewplane/commit/e5dbf3a6fc36f4ac4fe86c646d0eaa08c68ee08d))
* extract portable orchestration engine and embedded dashboard ([b44221e](https://github.com/yorch/crewplane/commit/b44221ef13cfd0cc996112a35ff8338ca64a3ff7))
* **release:** add curl installer with checksum verification ([b84c283](https://github.com/yorch/crewplane/commit/b84c283370890de85accbd1ee1049d95164561eb))
* **release:** add one-command release script and tag-triggered workflow ([2c3db99](https://github.com/yorch/crewplane/commit/2c3db996326e54f1941215316a3359fc01a287bd))
* **site:** add GitHub Pages website with landing page and generated docs ([7ed4d99](https://github.com/yorch/crewplane/commit/7ed4d9942492139a476a0ced3246459744fb60e4))


### Bug Fixes

* **config:** isolate Git context and declare reviewer roles ([7c716c6](https://github.com/yorch/crewplane/commit/7c716c6731b4edf59049b349c8e367c448d99314))
* **coordination:** align claim eligibility and close peer triage threads ([91ea7df](https://github.com/yorch/crewplane/commit/91ea7df01b7415f6e70c57620cc1ea8ff156ba18))
* **coordination:** normalize shared stores and refresh lock fixtures ([511defd](https://github.com/yorch/crewplane/commit/511defd2e536a02fce4ea389fa9eaa4afc32a443))
* **coordination:** verify primary integration before accepting work ([d568bd4](https://github.com/yorch/crewplane/commit/d568bd4e18c27ee29a2736412eeebaef7d0e92d7))
* **dashboard:** isolate graph faults and report complete usage ([0e692f7](https://github.com/yorch/crewplane/commit/0e692f7f4807479d2b306538a17822536111be04))
* **orchestration:** close checkpoint and native recovery gaps ([ad8e86a](https://github.com/yorch/crewplane/commit/ad8e86a58933321104d66b65ee51426af8b91c70))
* **orchestration:** preserve ownership and route revision-safe recovery ([829b415](https://github.com/yorch/crewplane/commit/829b415fa0e9e3794247603f24857fccc61fafd5))
* **storage:** make JSON publication directory durable ([563d9f9](https://github.com/yorch/crewplane/commit/563d9f96f58d358a7af36c7efcf5513abdf20bfa))
* **storage:** persist directory ancestry and expose retained ownership ([44a7f03](https://github.com/yorch/crewplane/commit/44a7f03b62371ed5be9d994485f68470a99a955b))
* **storage:** serialize evidence and traces across processes ([5feef53](https://github.com/yorch/crewplane/commit/5feef537c3e9be9e3387cfe3f198be64c73bf821))
