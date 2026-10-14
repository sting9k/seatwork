-- Closed issues past their keep are found by the time they closed, not by reading every issue.
CREATE INDEX issues_by_closing ON issues (closed_at) WHERE status = 'closed';
