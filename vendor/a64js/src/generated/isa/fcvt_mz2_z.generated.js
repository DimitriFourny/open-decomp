export const ENCODINGS = [
    {
        "instructionId": "fcvt_mz2_z",
        "encodingId": "fcvt_mz2_z_",
        "mnemonic": "FCVT",
        "className": "SME2",
        "fileName": "fcvt_mz2_z.xml",
        "mask": 4294966273,
        "value": 3248545792,
        "bitCount": 23,
        "fields": [
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zd",
                "lsb": 1,
                "width": 4
            },
            {
                "name": "L",
                "lsb": 0,
                "width": 1
            }
        ],
        "features": [
            "FEAT_SME_F16F16"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME_F16F16",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-widening-float-convert"
    }
];
