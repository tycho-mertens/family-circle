namespace FamilyCircle.Relay.Locations;

public record LocationRead(string SessionId, long? Revision);

public record LocationReadResult(string SessionId, string Status, LocationSnapshot? Snapshot);

public record LocationBatchRequest(string Generation, LocationRead[] Sessions);
