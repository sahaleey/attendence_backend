import {
  request as requestService,
  approve as approveService,
  reject as rejectService,
  list as listService,
} from '../services/attendance-correction.service.js';

export const list = async (req, res) =>
  res.json(
    await listService({
      status: req.query.status,
      academicYearId: req.query.academicYearId,
      standardId: req.query.standardId,
      page: req.query.page,
      pageSize: req.query.pageSize,
    })
  );

export const request = async (req, res) =>
  res.status(201).json({
    data: await requestService({
      attendanceRecordId: req.body.attendanceRecordId,
      newStatus: req.body.newStatus,
      newAbsenceTypeId: req.body.newAbsenceTypeId,
      reason: req.body.reason,
      requestedById: req.user.id,
      requester: req.user,
    }),
  });

export const approve = async (req, res) =>
  res.json({ data: await approveService(req.params.id, req.user.id, req.user) });

export const reject = async (req, res) =>
  res.json({
    data: await rejectService(req.params.id, req.user.id, {
      reviewer: req.user,
      reason: req.body?.reason,
    }),
  });
