export const ENCODINGS = [
    {
        "instructionId": "insr_z_v",
        "encodingId": "insr_z_v_",
        "mnemonic": "INSR",
        "className": "SVE",
        "fileName": "insr_z_v.xml",
        "mask": 4282383360,
        "value": 87308288,
        "bitCount": 20,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "Vm",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zdn",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE || FEAT_SME"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-insr"
    }
];
