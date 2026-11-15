import type { DeliveryDoc, DriverDoc, ManifestDoc, VehicleDoc } from '@courier/shared-types';
import { collection, doc, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import type { QueueSnapshot } from '../core/queue';
import { db } from './firebase';
import { actionQueue } from './queue';

export const BUSY_STATUSES = ['assigned', 'en_route_to_pickup', 'picked_up', 'at_destination_hub', 'out_for_delivery', 'delivery_failed', 'returning_to_sender'];

export function useDriver(uid: string) {
  const [driver, setDriver] = useState<DriverDoc | null | undefined>(undefined);
  useEffect(() => onSnapshot(doc(db, 'drivers', uid), (s) => setDriver(s.exists() ? (s.data() as DriverDoc) : null), () => setDriver(null)), [uid]);
  return driver;
}

export function useJobs(uid: string) {
  const [jobs, setJobs] = useState<DeliveryDoc[]>([]);
  useEffect(
    () =>
      onSnapshot(query(collection(db, 'deliveries'), where('currentDriverUid', '==', uid), where('status', 'in', BUSY_STATUSES)), (s) =>
        setJobs(s.docs.map((d) => d.data() as DeliveryDoc)),
      ),
    [uid],
  );
  return jobs;
}

export function useHistory(uid: string, enabled: boolean) {
  const [jobs, setJobs] = useState<DeliveryDoc[]>([]);
  useEffect(() => {
    if (!enabled) return;
    return onSnapshot(query(collection(db, 'deliveries'), where('driverUids', 'array-contains', uid), orderBy('updatedAt', 'desc'), limit(50)), (s) =>
      setJobs(s.docs.map((d) => d.data() as DeliveryDoc)),
    );
  }, [uid, enabled]);
  return jobs;
}

export function useAvailableVehicles(area: string | undefined) {
  const [vehicles, setVehicles] = useState<VehicleDoc[]>([]);
  useEffect(() => {
    if (!area) return;
    return onSnapshot(query(collection(db, 'vehicles'), where('homeServiceAreaId', '==', area), where('status', '==', 'available')), (s) =>
      setVehicles(s.docs.map((d) => d.data() as VehicleDoc)),
    );
  }, [area]);
  return vehicles;
}

export function useQueue(): QueueSnapshot {
  const [snap, setSnap] = useState<QueueSnapshot>(actionQueue.snapshot());
  useEffect(() => actionQueue.subscribe(setSnap), []);
  return snap;
}

/** Linehaul manifests this driver is driving (read access: own manifests only). */
export function useManifests(uid: string) {
  const [manifests, setManifests] = useState<ManifestDoc[]>([]);
  useEffect(
    () =>
      onSnapshot(query(collection(db, 'manifests'), where('driverUid', '==', uid), where('status', 'in', ['open', 'sealed', 'departed', 'arrived'])), (s) =>
        setManifests(s.docs.map((d) => d.data() as ManifestDoc)),
      ),
    [uid],
  );
  return manifests;
}
