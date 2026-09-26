\set ON_ERROR_STOP on

-- Provision only AFTER migrations 001-026, using the migration/owner role.
-- Required psql variables:
--   -v runtime_role=facturations_app
--   -v database_name=facturations
--
-- This file never creates a login and never contains a password.

\if :{?runtime_role}
\else
  \echo 'runtime_role psql variable is required'
  \quit 3
\endif

\if :{?database_name}
\else
  \echo 'database_name psql variable is required'
  \quit 3
\endif

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE, TEMPORARY ON DATABASE :"database_name" FROM PUBLIC;

REVOKE ALL PRIVILEGES ON DATABASE :"database_name" FROM :"runtime_role";
GRANT CONNECT ON DATABASE :"database_name" TO :"runtime_role";

REVOKE ALL PRIVILEGES ON SCHEMA public FROM :"runtime_role";
GRANT USAGE ON SCHEMA public TO :"runtime_role";

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM :"runtime_role";
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM :"runtime_role";

GRANT SELECT ON
  invoice_customers,
  invoice_drafts,
  invoice_audit_events,
  facturations_staff_users,
  facturations_staff_sessions,
  facturations_staff_invitations,
  facturations_draft_approvals,
  facturations_login_attempt_limits,
  facturations_staff_totp,
  facturations_draft_workspaces,
  facturations_draft_workspace_revisions,
  facturations_workspace_submissions,
  facturations_customer_contact_events,
  facturations_issuance_authorizations,
  facturations_provider_issuance_attempts,
  facturations_provider_issuance_events,
  facturations_issued_invoices,
  facturations_issued_invoice_documents,
  facturations_issuer_profiles,
  facturations_invoice_issuer_bindings,
  facturations_qualified_invoice_documents,
  facturations_delivery_authorizations,
  facturations_delivery_attempts,
  facturations_delivery_events,
  facturations_delivery_receipts,
  facturations_email_provider_evidence,
  facturations_payment_evidence,
  facturations_client_portal_users,
  facturations_client_access_links,
  facturations_client_sessions,
  facturations_client_portal_publications,
  facturations_client_portal_publication_revocations,
  facturations_email_provider_evidence_summary,
  facturations_payment_evidence_summary
TO :"runtime_role";

GRANT INSERT ON
  invoice_customers,
  invoice_drafts,
  invoice_audit_events,
  facturations_staff_users,
  facturations_staff_sessions,
  facturations_staff_invitations,
  facturations_draft_approvals,
  facturations_login_attempt_limits,
  facturations_staff_totp,
  facturations_draft_workspaces,
  facturations_draft_workspace_revisions,
  facturations_workspace_submissions,
  facturations_customer_contact_events,
  facturations_issuance_authorizations,
  facturations_provider_issuance_attempts,
  facturations_provider_issuance_events,
  facturations_issued_invoices,
  facturations_issued_invoice_documents,
  facturations_issuer_profiles,
  facturations_invoice_issuer_bindings,
  facturations_qualified_invoice_documents,
  facturations_delivery_authorizations,
  facturations_delivery_attempts,
  facturations_delivery_events,
  facturations_delivery_receipts,
  facturations_email_provider_evidence,
  facturations_payment_evidence,
  facturations_client_portal_users,
  facturations_client_access_links,
  facturations_client_sessions,
  facturations_client_portal_publications,
  facturations_client_portal_publication_revocations
TO :"runtime_role";

GRANT UPDATE ON
  invoice_customers,
  facturations_staff_users,
  facturations_staff_sessions,
  facturations_staff_invitations,
  facturations_login_attempt_limits,
  facturations_staff_totp,
  facturations_draft_workspaces,
  facturations_provider_issuance_attempts,
  facturations_delivery_attempts,
  facturations_client_portal_users,
  facturations_client_access_links,
  facturations_client_sessions
TO :"runtime_role";

GRANT DELETE ON facturations_login_attempt_limits TO :"runtime_role";

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :"runtime_role";
