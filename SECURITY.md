# 安全政策

## 支持的版本

安全修复以 `main` 为准。请在报告中注明受影响的版本、提交或镜像标签。

## 报告漏洞

请通过 GitHub 私密报告提交漏洞。报告中请写明受影响的版本、复现步骤和实际影响。与部署有关时，请附上脱敏后的配置或日志。 [私密报告入口](https://github.com/leafliber/Protea/security/advisories/new)

## 响应

- 7 天内确认收到并给出初步判断。
- 确认的问题在修复发布后公开说明；需要协调披露时间的，按报告者的意见商定。

## 范围

项目受理守护进程、控制平面（HTTP、WebSocket、控制台）、仓库维护的插件、插件宿主与协议、镜像和入口脚本中的漏洞。

第三方插件或 MCP 服务器自身的漏洞请报告给相应维护者。管理员令牌和数据卷写权限属于部署所有者的信任边界。

设计上的威胁模型、已知的残余风险与发布前检查清单见 [docs/10-architecture/14-security-and-permissions.md](docs/10-architecture/14-security-and-permissions.md)。
