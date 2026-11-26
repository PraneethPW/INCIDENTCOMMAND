# Supabase PostgreSQL trust anchor

`supabase-root.crt` is Supabase's public Root 2021 CA, downloaded over HTTPS from the URL referenced by the official Supabase Studio SSL settings source:

- Source: https://github.com/supabase/supabase/blob/master/apps/studio/hooks/custom-content/custom-content.json (`ssl:certificate_url`, production environment).
- Certificate: https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt
- SHA-256: `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`
- Valid through April 26, 2031. Review provider certificate rotations before this date.

This is a public CA certificate, not a password or private key. It is used only for Supabase database hosts, with certificate and hostname verification enabled. `DATABASE_SSL_CA` can supply a reviewed replacement CA. The backend never disables certificate verification for hosted databases.
