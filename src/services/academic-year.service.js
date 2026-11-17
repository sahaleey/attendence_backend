import prisma from '../lib/prisma.js';
import { ApiError } from '../utils/api-error.js';
import { parseSchoolDateStrict } from '../utils/date.js';

// Only these fields are client-editable; status and attendanceStarted move via dedicated actions.
const pickYearFields = (data = {}, { partial }) => {
  const out = {};
  if (data.name !== undefined) {
    const name = String(data.name || '').trim();
    if (!name) throw new ApiError(400, 'name is required');
    out.name = name;
  } else if (!partial) {
    throw new ApiError(400, 'name is required');
  }

  for (const field of ['startDate', 'endDate']) {
    if (data[field] !== undefined) out[field] = parseSchoolDateStrict(data[field], field);
    else if (!partial) throw new ApiError(400, `${field} is required in YYYY-MM-DD format`);
  }
  return out;
};

const assertDateOrder = (startDate, endDate) => {
  if (startDate >= endDate) throw new ApiError(400, 'startDate must be before endDate');
};

export const create = async (data) => {
  const fields = pickYearFields(data, { partial: false });
  assertDateOrder(fields.startDate, fields.endDate);

  return prisma.$transaction(async (tx) => {
    const year = await tx.academicYear.create({ data: fields });
    await tx.timetableSetting.create({ data: { academicYearId: year.id } });
    await tx.attendanceSetting.create({ data: { academicYearId: year.id } });
    return year;
  });
};

export const update = async (id, data) => {
  const y = await prisma.academicYear.findUnique({ where: { id } });
  if (!y) throw new ApiError(404, 'Academic year not found');

  const fields = pickYearFields(data, { partial: true });
  if (Object.keys(fields).length === 0) {
    throw new ApiError(400, 'Nothing to update. Editable fields: name, startDate, endDate');
  }

  if (y.status === 'COMPLETED') {
    throw new ApiError(409, 'A completed academic year cannot be edited');
  }
  if (y.attendanceStarted && (fields.startDate || fields.endDate)) {
    throw new ApiError(409, 'Academic year dates cannot be changed after attendance starts');
  }

  assertDateOrder(fields.startDate || y.startDate, fields.endDate || y.endDate);

  return prisma.academicYear.update({ where: { id }, data: fields });
};

// Lifecycle: DRAFT -> ACTIVE -> COMPLETED.
export const activate = async (id) =>
  prisma.$transaction(async (tx) => {
    const y = await tx.academicYear.findUnique({ where: { id } });
    if (!y) throw new ApiError(404, 'Academic year not found');
    if (y.status === 'ACTIVE') return y;
    if (y.status === 'COMPLETED') {
      throw new ApiError(409, 'A completed academic year cannot be re-activated');
    }

    const active = await tx.academicYear.findFirst({
      where: { status: 'ACTIVE', id: { not: id } },
    });
    if (active) {
      throw new ApiError(409, 'Another academic year is already active');
    }

    return tx.academicYear.update({ where: { id }, data: { status: 'ACTIVE' } });
  });

export const complete = async (id) =>
  prisma.$transaction(async (tx) => {
    const y = await tx.academicYear.findUnique({ where: { id } });
    if (!y) throw new ApiError(404, 'Academic year not found');
    if (y.status === 'COMPLETED') return y;
    if (y.status !== 'ACTIVE') {
      throw new ApiError(409, 'Only an active academic year can be completed');
    }
    return tx.academicYear.update({ where: { id }, data: { status: 'COMPLETED' } });
  });

export const list = () =>
  prisma.academicYear.findMany({ orderBy: { startDate: 'desc' } });

export default {
  create,
  update,
  activate,
  complete,
  list,
};
