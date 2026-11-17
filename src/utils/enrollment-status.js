// Legacy rows were stored as ENROLLED; both values mean "currently enrolled".
export const ACTIVE_ENROLLMENT_STATUSES = Object.freeze(['ACTIVE', 'ENROLLED']);

export const activeEnrollmentFilter = () => ({ in: [...ACTIVE_ENROLLMENT_STATUSES] });

export const isActiveEnrollment = (status) => ACTIVE_ENROLLMENT_STATUSES.includes(status);
