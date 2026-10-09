PRAGMA foreign_keys = ON;
INSERT INTO authz_permissions(code) VALUES('org.inspection.execute');
INSERT INTO authz_role_permissions(role_id,permission_code) VALUES
 ('org-owner','org.inspection.execute'),
 ('org-admin','org.inspection.execute'),
 ('org-inspector','org.inspection.execute');
