using FamilyCircle.Relay.Models;
using Microsoft.EntityFrameworkCore;

namespace FamilyCircle.Relay.Data;

public class RelayDbContext(DbContextOptions<RelayDbContext> options) : DbContext(options)
{
    public DbSet<Envelope> Envelopes => Set<Envelope>();
    public DbSet<MailboxCursor> MailboxCursors => Set<MailboxCursor>();
    public DbSet<Mailbox> Mailboxes => Set<Mailbox>();
    public DbSet<Backup> Backups => Set<Backup>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Envelope>(e =>
        {
            e.HasKey(x => x.SequenceId);
            e.Property(x => x.SequenceId).ValueGeneratedOnAdd();
            // Idempotent upload: duplicate (MailboxId, EventId) is a no-op.
            e.HasIndex(x => new { x.MailboxId, x.EventId }).IsUnique();
            e.HasIndex(x => new { x.MailboxId, x.SequenceId });
        });

        modelBuilder.Entity<MailboxCursor>(e =>
        {
            e.HasKey(x => x.MailboxId);
        });

        modelBuilder.Entity<Mailbox>(e =>
        {
            e.HasKey(x => x.MailboxId);
        });

        modelBuilder.Entity<Backup>(e =>
        {
            e.HasKey(x => x.BackupId);
        });
    }
}
