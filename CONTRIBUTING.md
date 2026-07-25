# 参与贡献

感谢你愿意帮助改进 Cursor Studio。

## 开始之前

- 使用 Issue 报告可复现的问题，使用 Discussions 讨论使用体验和想法。
- 准备修改前先搜索现有 Issue 和 Pull Request，避免重复工作。
- 功能改动请保持界面文案面向普通用户，并与现有桌面体验保持一致。

## 提交改动

1. 从 `main` 创建清晰命名的分支。
2. 保持改动聚焦，不提交 `node_modules`、构建产物、日志或本地配置。
3. 在提交前运行：

   ```powershell
   npm run typecheck
   npm run build
   ```

4. 在 Pull Request 中说明改动内容、影响范围和验证方式；涉及界面的改动请附上截图。

## 问题反馈

请写明使用的版本、Windows 版本、复现步骤、预期结果和实际结果。不要在公开内容中包含访问密钥、个人对话或其他敏感信息。
