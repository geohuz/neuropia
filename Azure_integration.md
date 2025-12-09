# Azure Marketplace + Portkey 开源网关说明

使用 Portkey Gateway 的开源版（自托管），不能获得 Portkey Cloud 那套“快速上线（fast onboarding）”的优势。

因为所谓的“快速上线优势”来自 **Portkey Cloud**，而不是 **Portkey OSS**。

Portkey Cloud 才有的“快速上线”能力包括：

| 能力                               | Portkey Cloud | Portkey OSS（自托管） | 必要性 |
| ---------------------------------- | ------------- | --------------------- | ------ |
| Azure Marketplace 一键部署         | ✔             | ❌（自己部署）         |        |
| Azure Entra SSO / SCIM             | ✔             | ❌                     | ***    |
| Azure Cost visualization           | ✔             | ❌                     |        |
| Traffic runs inside Azure backbone | ✔             | ❌                     |        |
| Logs/metrics 自动托管              | ✔             | ❌                     |        |
| Zero maintenance                   | ✔             | ❌（自己维护）         |        |

## **Marketplace → 用于 Onboarding（好处：成交更快）**

企业客户喜欢 Marketplace，因为：

- 无需采购审批
- 无需合同
- 自动计费
- 可以直接从 Azure 控制台启用
- 对“是否可信”默认加分

**这确实能加速销售流程，但不是技术上线速度。**

| 项目         | Marketplace | Portkey OSS | Portkey Cloud |
| ------------ | ----------- | ----------- | ------------- |
| 销售流程变快 | ⭐⭐⭐⭐⭐       | ❌           | ⭐⭐⭐⭐⭐         |
| 技术上线速度 | ⭐           | ⭐           | ⭐⭐⭐⭐⭐         |
| 运维压力     | 中          | 高          | 低            |
| 企业信任度   | 高          | 中          | 非常高        |
| 保留利润率   | 完整保留    | 完整保留    | 容易被稀释    |
| 是否适合我们 | ✔           | ✔           | ❌（会吃利润） |

# Portkey OSS 的企业 Onboarding 必须补齐的内容

**SSO（Azure Entra ID 登录）**

**SCIM（自动同步用户/部门）**

**审计与权限控制（logs, access policies）**

| 项目                         | 是否必须 | 实现难度 | 说明            |
| ---------------------------- | -------- | -------- | --------------- |
| Azure SSO (需要补)           | ⭐⭐⭐⭐⭐    | 中       | 最重要、必须补  |
| SCIM 自动同步 (需要补)       | ⭐⭐⭐⭐     | 中       | 企业一般会要求  |
| 审计日志 / 监控 (调整)       | ⭐⭐⭐      | 中-低    | 合规需求        |
| Azure Backbone / VNet (可选) | ⭐        | 高       | 政府/金融才需要 |

**Portkey Cloud 的企业级 onboarding 都可以自己做，最重要的是 Azure Entra SSO 和 SCIM，做完这两个，80% 的企业客户都能顺利上线。**

