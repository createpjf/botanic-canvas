# Supabase 操作说明

此目录已包含 Botanic 的 schema、RLS、Storage policy 和原子项目写入 RPC。

```bash
supabase init
supabase login
supabase link --project-ref <your-project-ref>
supabase db push
```

`supabase link` 与 `supabase db push` 会改变远端项目，因此仅在已确认目标 Supabase 项目后执行。执行完成后，在项目 Dashboard 的 Auth 中启用 Email Provider、配置站点与邀请回调 URL，并将项目 URL、publishable key、secret key 写入部署平台密钥管理。
