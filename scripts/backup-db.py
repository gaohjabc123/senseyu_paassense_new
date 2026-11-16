import sqlite3, sys
src = '/var/lib/docker/volumes/ruying-data-v2/_data/ruying.db'
dst = sys.argv[1]
sqlite3.connect(src).execute('VACUUM INTO "%s"' % dst)
print(sqlite3.connect(dst).execute('PRAGMA integrity_check').fetchone()[0])
