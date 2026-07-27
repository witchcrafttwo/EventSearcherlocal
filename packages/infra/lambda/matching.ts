import type { EventRecord, UserProfile } from "./types.js";

export function matchesProfile(event: EventRecord, profile: UserProfile): boolean {
  if (!matchesArea(event.area, profile.area)) return false;
  if (!matchesAge(event, profile.childAge)) return false;
  return matchesInterests(event.interests, profile.interests);
}

function matchesArea(eventArea: string, profileArea: string): boolean {
  const eventValue = eventArea.trim();
  const profileValue = profileArea.trim();
  if (!eventValue || !profileValue) return true;
  return eventValue.includes(profileValue) || profileValue.includes(eventValue) || eventValue === "県内";
}

function matchesAge(event: EventRecord, childAge: number): boolean {
  if (typeof event.targetAgeMin === "number" && childAge < event.targetAgeMin) return false;
  if (typeof event.targetAgeMax === "number" && childAge > event.targetAgeMax) return false;
  return true;
}

function matchesInterests(eventInterests: string[], profileInterests: string[]): boolean {
  if (profileInterests.length === 0) return true;
  const joinedEvent = eventInterests.join(" ");
  return profileInterests.some((interest) => joinedEvent.includes(interest) || eventInterests.includes(interest));
}
