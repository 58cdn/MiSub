# Windows 检测器安装权限

检测器安装在当前用户的 `%LOCALAPPDATA%\MiSubProbe`，配置使用当前用户和 SYSTEM 专用权限。请从已有普通用户桌面的开始菜单正常打开 PowerShell 5.1 或更高版本，使用 Windows x64 安装入口。

## 出现 `bootstrap_requires_regular_user` 时

这个错误表示安装脚本观察到当前进程启用了 Administrators 角色，或者正在以 SYSTEM 运行。检查依据是 Windows 身份和当前令牌，不是用户名、终端标题或工作目录。`PS C:\Users\Administrator>` 不能单独证明进程是否提升，也不能证明账户就是内置 Administrator。

1. 关闭本次安装使用的提升终端，从已有用户桌面的开始菜单正常打开 PowerShell，不选择“以管理员身份运行”。从提升终端启动另一个 `powershell.exe` 可能仍继承提升权限。
2. 在新终端运行下面的只读检查。若 `System` 或 `AdministratorRoleEnabled` 为 `True`，不要继续安装；使用已有标准用户的 Windows 登录会话，或请设备管理员提供普通用户运行环境。
3. 对于内置 Administrator 的完整管理员会话，简单重开终端不保证获得普通令牌。使用已有普通账户；不要为了安装修改 UAC、账户组成员、安全策略或脚本执行策略。
4. 具备普通令牌后，从 MiSub 创建新的安装窗口并复制命令。旧窗口可能已过期；已有配置或已配对身份应走明确的恢复流程，避免重复身份。

只读检查仅输出三个布尔值，不读取检测器配置、不输出账号或 SID，也不修改系统：

```powershell
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
try {
    [pscustomobject]@{
        System = $identity.IsSystem
        AdministratorRoleEnabled = ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        BuiltInAdministrator = $identity.User.IsWellKnown([Security.Principal.WellKnownSidType]::AccountAdministratorSid)
    }
} finally { $identity.Dispose() }
```

`BuiltInAdministrator` 只帮助解释账户身份，不单独决定是否允许安装。受 UAC 过滤的管理员进程可能没有启用管理员角色。原生安装器还独立读取 `TokenElevation`；提升状态不为零，或无法读取该状态时，以 `installation_requires_regular_user` 停止。因此前面的布尔检查通过后，仍需通过原生安装器的正常预检。

## 支持边界

| 当前运行上下文                             | PowerShell 权限预检 | 操作路径                                       |
| ------------------------------------------ | ------------------- | ---------------------------------------------- |
| 标准用户，普通令牌                         | 允许继续其他预检    | 使用当前用户目录安装                           |
| 管理员组成员，当前为 UAC 过滤的普通令牌    | 允许继续其他预检    | 使用当前用户目录安装                           |
| 当前令牌启用管理员角色                     | 拒绝                | 从已有普通用户桌面正常打开 PowerShell          |
| 内置 Administrator，当前令牌启用管理员角色 | 拒绝                | 使用已有普通账户；重开同一会话的终端不保证有效 |
| 内置 Administrator，当前为普通令牌         | 允许继续其他预检    | 仍须通过原生 `TokenElevation` 和私有目录检查   |
| SYSTEM                                     | 拒绝                | 使用已有普通用户登录会话                       |

Windows 安装器不提供提升权限安装、系统级服务或自动降权选项，也不会创建账户、索取账户密码或自动切换身份。无法获得普通令牌的机器暂不支持此用户级安装路径。不要手动删除权限检查或修改既有私有目录的 ACL 以继续。

支持 Windows 10 / Windows Server 2016 及以上的原生 x64；Windows ARM64 不在当前发行支持范围内。完整的目录、权限、配置保存及显式启动规则见 [Windows 原生检测器](detector-windows.md)。

## 检查依据

- [Microsoft：WindowsPrincipal.IsInRole](https://learn.microsoft.com/en-us/dotnet/api/system.security.principal.windowsprincipal.isinrole) 说明当前普通令牌的管理员组成员可能返回 false。
- [Microsoft：TOKEN_ELEVATION](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-token_elevation) 定义原生提升状态。
- [Microsoft：UAC 设置与配置](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/user-account-control/settings-and-configuration) 说明内置 Administrator 的 Admin Approval Mode 会影响应用使用的权限。此说明不要求修改该设置。
