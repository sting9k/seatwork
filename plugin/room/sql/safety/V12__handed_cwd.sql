-- The folder a seat handed its work in from: the worktree of its project it worked in, which need not be the folder it started in.
ALTER TABLE seats ADD COLUMN handed_cwd TEXT;
