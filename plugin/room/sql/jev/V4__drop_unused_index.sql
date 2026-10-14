-- No lookup reads answers by question, so this index only costs a write for each answer.
DROP INDEX asks_by_question;
