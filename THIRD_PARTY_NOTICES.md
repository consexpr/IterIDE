# 随附资源

本项目自有源码的许可见 [LICENSE](LICENSE)。第三方组件遵循各自的许可证，项目许可证不会替代它们。

| 资源                    | 来源与许可文件                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| ONNX Runtime Web 1.22.0 | 随附 [MIT License](app/resources/model/runtime/LICENSE.txt) 和 [ThirdPartyNotices](app/resources/model/runtime/ThirdPartyNotices.txt) |
| testlib                 | 随附 [LICENSE](app/resources/testlib/LICENSE)；版权声明同时保留在 `testlib.h` 中                                                      |
| WinLibs 工具链          | 由 `app/scripts/fetch-toolchain.mjs` 从固定上游发行包下载，发行包的许可证随工具链保留；下载内容不进入源码仓库                         |
| npm 依赖                | 版本固定于 `app/package-lock.json`，各包的许可随安装内容分发                                                                          |

`app/resources/model/ranker.onnx` 和 `app/src/renderer/assets/login-hero.mp4` 作为项目运行资源随源码提供；项目维护者已确认可公开分发。模型的输入协议和资源版本记录于 [manifest.json](app/resources/model/manifest.json) 与[模型协议](app/docs/model-protocol.md)。

构建安装包时保留 Electron、工具链、ONNX Runtime 和 testlib 的版权及许可证文件。
