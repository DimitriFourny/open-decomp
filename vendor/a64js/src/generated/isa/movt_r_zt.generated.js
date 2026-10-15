export const ENCODINGS = [
    {
        "instructionId": "movt_r_zt",
        "encodingId": "movt_r_zt_",
        "mnemonic": "MOVT",
        "className": "SME2",
        "fileName": "movt_r_zt.xml",
        "mask": 4294938592,
        "value": 3226207200,
        "bitCount": 24,
        "fields": [
            {
                "name": "off3",
                "lsb": 12,
                "width": 3
            },
            {
                "name": "opc",
                "lsb": 5,
                "width": 7
            },
            {
                "name": "Rt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SME2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "guardDiagnostics": [
            "Halted(): debug halt state is not configured; assumes the instruction is admitted by the implementation"
        ],
        "operandFamilyId": "sme-movt-scalar"
    }
];
