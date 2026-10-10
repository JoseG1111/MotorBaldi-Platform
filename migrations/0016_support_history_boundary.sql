-- A CLOSED case accepts only the first closing receipt in the closing transaction.
-- Later INSERTs cannot append to terminal history, including a second CLOSE.
DROP TRIGGER support_history_insert_guard;
CREATE TRIGGER support_history_insert_guard BEFORE INSERT ON support_case_history
WHEN NOT EXISTS(SELECT 1 FROM support_cases c WHERE c.id=NEW.case_id AND c.last_actor_account_id=NEW.actor_account_id
 AND ((NEW.action='CLOSE' AND c.status='CLOSED' AND NOT EXISTS(SELECT 1 FROM support_case_history h WHERE h.case_id=c.id AND h.action='CLOSE'))
 OR (NEW.action<>'CLOSE' AND c.status<>'CLOSED')))
BEGIN SELECT RAISE(ABORT,'SUPPORT_HISTORY_BOUNDARY'); END;
