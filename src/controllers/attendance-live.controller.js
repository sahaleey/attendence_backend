import * as service from '../services/attendance-live.service.js';

export const getLiveBoard = async (req, res) =>
  res.json({
    data: await service.getLiveBoard({
      date: req.query.date,
      academicYearId: req.query.academicYearId,
      standardId: req.query.standardId,
    }),
  });
