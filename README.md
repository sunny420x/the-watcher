# The Watcher, Small but powerfull Cyberspace search engine.
<img width="1902" height="897" alt="Screenshot 2569-09-23 at 23 16 17" src="https://github.com/user-attachments/assets/45571410-1d1b-45a4-ba61-0c7de459b4e9" />

## What is the watcher ?
The watcher is a web-based subnet observatory tool, help discovering services such as web server, ip camera, ftp and ssh in each subnet on globle IPv4 range.

## Installation
Install dependencies using this command:
<pre>
npm i
</pre>
And run the server using this command:
<pre>
node run.js
</pre>
Accessing web interface at this URL:
<pre>
http://localhost:4002
</pre>

## Database schema updates
On startup, The Watcher reads `schema/database.sql`, compares its tables, columns, indexes, engine, and character set with MySQL, and applies compatible changes before accepting requests. The current schema snapshot and migration history are stored in `schema_migration_state` and `schema_migration_history`.

Columns removed from `database.sql` are preserved to avoid deleting stored data; the migration logs a warning for those columns. Column, index, or table changes that MySQL cannot apply are recorded as failed migrations and prevent the server from starting until the schema issue is resolved.

# Discovering building in dark forest is kinda.. fun!
In the watcher, you can scan services from all over the world ! it's like walking through the jungle and discovering what is "awake".
